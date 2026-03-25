"""
Maque OCR Agent  —  port 51822
Anchor-based Air Waybill field extraction using PaddleOCR.

Install deps (run once, as the service user):
    pip install paddlepaddle paddleocr opencv-python-headless pillow --break-system-packages

The agent exposes one endpoint:
    POST /ocr   { "image": "<base64-encoded image>" }
    →           { "fields": {...}, "confidence": {...}, "raw_blocks": [...] }

Anchor strategy
───────────────
We never rely on fixed pixel coordinates. Instead we:
  1. Run PaddleOCR on the whole image → list of (text, bbox, score) blocks
  2. For each target field, search for its Chinese label anchor (e.g. "毛重")
  3. Find the nearest numeric / text block in the expected spatial direction
  4. Validate with a regex and assign a confidence score

This works across all IATA Air Waybill templates (Air China, Sichuan Airlines,
etc.) because the label text is standardised by regulation even when layout differs.
"""

import base64
import http.server
import io
import json
import logging
import math
import os
import re
import sys
import threading
from pathlib import Path

# ── Optional: secret auth (same pattern as VPN agent) ─────────────────────────
IS_WIN      = sys.platform == 'win32'
SECRET_FILE = (r'C:\ProgramData\MaqueOMS\ocr.secret' if IS_WIN
               else '/etc/maque-ocr.secret')
PORT        = 51822

logging.basicConfig(
    level=logging.INFO,
    format='[ocr-agent] %(asctime)s %(levelname)s %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('ocr-agent')

# ── Lazy-load PaddleOCR so the HTTP server starts immediately ──────────────────
_ocr = None
_ocr_lock = threading.Lock()

def get_ocr():
    global _ocr
    if _ocr is not None:
        return _ocr
    with _ocr_lock:
        if _ocr is None:
            log.info('Loading PaddleOCR model...')
            from paddleocr import PaddleOCR

            # Model files are bundled alongside this script under ./models/
            # so the sidecar never downloads anything at runtime.
            # Directory layout (created by prepare-windows-resources.sh /
            # install-ocr-agent.sh during developer setup):
            #   <script_dir>/models/det/   — text detection model
            #   <script_dir>/models/rec/   — text recognition model (ch)
            #   <script_dir>/models/cls/   — angle classification model
            models_dir = Path(__file__).parent / 'models'
            det_dir = models_dir / 'det'
            rec_dir = models_dir / 'rec'
            cls_dir = models_dir / 'cls'

            kwargs = dict(
                use_angle_cls=True,
                lang='ch',
                show_log=False,
                use_gpu=False,
            )
            # Use bundled models if present; otherwise fall back to auto-download
            # (only happens in developer/testing environments)
            if det_dir.exists() and rec_dir.exists() and cls_dir.exists():
                kwargs.update(
                    det_model_dir=str(det_dir),
                    rec_model_dir=str(rec_dir),
                    cls_model_dir=str(cls_dir),
                )
                log.info('Using bundled models from %s', models_dir)
            else:
                log.warning('Bundled models not found at %s — falling back to download', models_dir)

            _ocr = PaddleOCR(**kwargs)
            log.info('PaddleOCR model ready.')
    return _ocr


# ── Geometry helpers ───────────────────────────────────────────────────────────

def bbox_center(bbox):
    """Return (cx, cy) of a 4-point bbox [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]."""
    xs = [p[0] for p in bbox]
    ys = [p[1] for p in bbox]
    return (sum(xs) / 4, sum(ys) / 4)

def bbox_right_edge(bbox):
    return max(p[0] for p in bbox)

def bbox_bottom_edge(bbox):
    return max(p[1] for p in bbox)

def bbox_top_edge(bbox):
    return min(p[1] for p in bbox)

def bbox_left_edge(bbox):
    return min(p[0] for p in bbox)

def distance(c1, c2):
    return math.sqrt((c1[0]-c2[0])**2 + (c1[1]-c2[1])**2)

def is_right_of(anchor_bbox, candidate_bbox, tolerance_y=30):
    """True if candidate is to the right of anchor, roughly same row."""
    ax_right = bbox_right_edge(anchor_bbox)
    ay_mid   = (bbox_top_edge(anchor_bbox) + bbox_bottom_edge(anchor_bbox)) / 2
    cy_mid   = (bbox_top_edge(candidate_bbox) + bbox_bottom_edge(candidate_bbox)) / 2
    cx_left  = bbox_left_edge(candidate_bbox)
    return cx_left > ax_right and abs(ay_mid - cy_mid) < tolerance_y

def is_below(anchor_bbox, candidate_bbox, tolerance_x=80, max_gap=120):
    """True if candidate is directly below anchor."""
    ax_mid   = (bbox_left_edge(anchor_bbox) + bbox_right_edge(anchor_bbox)) / 2
    ay_bot   = bbox_bottom_edge(anchor_bbox)
    cx_mid   = (bbox_left_edge(candidate_bbox) + bbox_right_edge(candidate_bbox)) / 2
    cy_top   = bbox_top_edge(candidate_bbox)
    return (cy_top > ay_bot and
            cy_top - ay_bot < max_gap and
            abs(ax_mid - cx_mid) < tolerance_x)


# ── Field extraction rules ─────────────────────────────────────────────────────

# Each anchor is a list of strings — we match if ANY of them appears in a block
ANCHORS = {
    'waybill_number': {
        # AWB number is printed large at top — no label needed, just find the
        # XXX-XXXXXXXX pattern directly
        'pattern': r'\b(\d{3}[-\s]\d{8})\b',
        'mode': 'pattern_scan',
    },
    'gross_weight': {
        'anchors': ['毛重', 'Gross Weight', 'GROSS WEIGHT', '毛重(千克)'],
        'mode': 'right_or_below',
        'pattern': r'(\d{2,5}(?:[.,]\d{1,2})?)',
        'cast': float,
    },
    'chargeable_weight': {
        'anchors': ['计费重量', 'Chargeable Weight', 'CHARGEABLE', '计费重量(千克)'],
        'mode': 'right_or_below',
        'pattern': r'(\d{2,5}(?:[.,]\d{1,2})?)',
        'cast': float,
    },
    'piece_count': {
        'anchors': ['件数', 'No.of Pcs', 'No. of Pcs', 'NUMBER OF PIECES', 'PCS'],
        'mode': 'right_or_below',
        'pattern': r'^(\d{1,5})$',
        'cast': int,
    },
    'flight_code': {
        'anchors': ['航班', 'Flight', 'Flight/Date', '航班/日期'],
        'mode': 'right_or_below',
        'pattern': r'\b([A-Z]{2}\d{3,4})\b',
    },
    'flight_date': {
        'anchors': ['航班/日期', 'Flight/Date', '日期', 'Date'],
        'mode': 'right_or_below',
        # Match YYYY-MM-DD, YYYY.MM.DD, YYYY/MM/DD, or partial like 2025.10.26
        'pattern': r'(\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{4})',
    },
    'destination': {
        'anchors': ['目的地', '目的站', 'Airport of Destination', 'Destination'],
        'mode': 'right_or_below',
        'pattern': r'(.{2,20})',   # Any 2–20 char text
        'validator': 'not_purely_numeric',
    },
    'item_description': {
        'anchors': ['货物品名', '品名', 'Description of Goods', 'DESCRIPTION OF GOODS',
                    '货物品名（包括包装尺寸或体积）'],
        'mode': 'right_or_below_multi',  # grab all text blocks in the cell zone
        'pattern': r'(.+)',
    },
}

# Airport code → city name mapping for destination normalisation
AIRPORT_MAP = {
    'TFU': '成都天府', 'CTU': '成都', 'CAN': '广州', 'TYN': '太原',
    'PEK': '北京', 'PKX': '北京大兴', 'SHA': '上海', 'PVG': '浦东',
    'SZX': '深圳', 'WUH': '武汉', 'XIY': '西安', 'CKG': '重庆',
    'HGH': '杭州', 'NKG': '南京', 'CSX': '长沙', 'KMG': '昆明',
    'HAK': '海口', 'SYX': '三亚', 'URC': '乌鲁木齐',
}
# Reverse map: city fragment → canonical destination
CITY_NORMALIZE = {v: v for v in AIRPORT_MAP.values()}
CITY_NORMALIZE.update({
    '成都天府': '成都天府(TFU)', '成都': '成都(CTU)',
    '广州': '广州(CAN)', '太原': '太原(TYN)',
    '北京': '北京(PEK)', '上海': '上海(SHA)',
    '深圳': '深圳(SZX)', '武汉': '武汉(WUH)',
    '西安': '西安(XIY)', '重庆': '重庆(CKG)',
    '杭州': '杭州(HGH)', '南京': '南京(NKG)',
    '长沙': '长沙(CSX)', '昆明': '昆明(KMG)',
    '乌鲁木齐': '乌鲁木齐(URC)',
})


def find_anchor_block(blocks, anchor_texts):
    """Return the block whose text contains any of the anchor strings."""
    for text, bbox, score in blocks:
        for a in anchor_texts:
            if a in text:
                return (text, bbox, score)
    return None


def find_nearest_right_or_below(anchor_bbox, blocks, pattern, exclude_bbox=None):
    """
    Among all blocks to the right of or below anchor_bbox, find the one
    whose text matches `pattern`. Returns (matched_text, bbox, raw_score).
    Prefers right-of over below; within each direction prefers closest.
    """
    right_candidates = []
    below_candidates = []

    for text, bbox, score in blocks:
        if exclude_bbox is not None and bbox == exclude_bbox:
            continue
        m = re.search(pattern, text.replace(' ', '').replace(',', '.'))
        if not m:
            continue
        if is_right_of(anchor_bbox, bbox):
            right_candidates.append((distance(bbox_center(anchor_bbox),
                                               bbox_center(bbox)), m.group(1), bbox, score))
        elif is_below(anchor_bbox, bbox):
            below_candidates.append((distance(bbox_center(anchor_bbox),
                                               bbox_center(bbox)), m.group(1), bbox, score))

    for candidates in (right_candidates, below_candidates):
        if candidates:
            candidates.sort(key=lambda x: x[0])
            _, value, bbox, score = candidates[0]
            return value, bbox, score
    return None, None, 0.0


def pattern_scan(blocks, pattern):
    """Scan all blocks for a regex pattern, return best match by score."""
    best = None
    best_score = 0.0
    for text, bbox, score in blocks:
        m = re.search(pattern, text.replace(' ', '-'))
        if m and score > best_score:
            best = (m.group(1), bbox, score)
            best_score = score
    return best if best else (None, None, 0.0)


def collect_cell_text(anchor_bbox, blocks, max_blocks=6):
    """
    Collect up to max_blocks text blocks that are below and near the anchor.
    Used for multi-line fields like item description.
    """
    results = []
    ax_left  = bbox_left_edge(anchor_bbox)
    ax_right = bbox_right_edge(anchor_bbox)
    ay_bot   = bbox_bottom_edge(anchor_bbox)

    candidates = []
    for text, bbox, score in blocks:
        cx_mid = (bbox_left_edge(bbox) + bbox_right_edge(bbox)) / 2
        cy_top = bbox_top_edge(bbox)
        # Must be below anchor and within horizontal bounds (±120px)
        if cy_top > ay_bot and abs(cx_mid - (ax_left+ax_right)/2) < 200:
            candidates.append((cy_top, text, score))

    candidates.sort(key=lambda x: x[0])
    for _, text, score in candidates[:max_blocks]:
        results.append(text)
    return ' '.join(results) if results else None


def compute_field_confidence(raw_ocr_score, value, rule):
    """
    Blend OCR detector score with a rule-based plausibility check.
    Returns 0.0–1.0.
    """
    if value is None:
        return 0.0
    base = float(raw_ocr_score)

    # Plausibility boosts / penalties
    if rule == 'waybill_number':
        # Should be exactly XXX-XXXXXXXX
        if re.fullmatch(r'\d{3}-\d{8}', str(value)):
            base = min(1.0, base + 0.1)
        else:
            base *= 0.7

    elif rule in ('gross_weight', 'chargeable_weight'):
        v = float(value)
        if 10 <= v <= 9999:   # realistic AWB weight range
            base = min(1.0, base + 0.05)
        else:
            base *= 0.5

    elif rule == 'piece_count':
        v = int(value)
        if 1 <= v <= 9999:
            base = min(1.0, base + 0.05)
        else:
            base *= 0.5

    elif rule == 'flight_code':
        if re.fullmatch(r'[A-Z]{2}\d{3,4}', str(value)):
            base = min(1.0, base + 0.1)
        else:
            base *= 0.6

    elif rule == 'flight_date':
        # Full date is more reliable than year-only
        if re.search(r'\d{4}[-./]\d{2}[-./]\d{2}', str(value)):
            base = min(1.0, base + 0.05)
        else:
            base *= 0.75

    elif rule == 'item_description':
        # Description is inherently uncertain
        base = min(base, 0.75)

    return round(min(max(base, 0.0), 1.0), 3)


def normalize_date(raw):
    """Normalise various date formats to YYYY-MM-DD."""
    if not raw:
        return raw
    m = re.search(r'(\d{4})[-./](\d{1,2})[-./](\d{1,2})', raw)
    if m:
        return f'{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}'
    # Year only — return as-is, form will treat it as partial
    m = re.match(r'^(\d{4})$', raw.strip())
    if m:
        return m.group(1)
    return raw


def normalize_destination(raw):
    """Map OCR destination text to canonical city name."""
    if not raw:
        return raw
    raw = raw.strip()
    # Direct airport code
    if raw.upper() in AIRPORT_MAP:
        city = AIRPORT_MAP[raw.upper()]
        return CITY_NORMALIZE.get(city, city)
    # City fragment lookup
    for fragment, canonical in CITY_NORMALIZE.items():
        if fragment in raw:
            return canonical
    # Fallback: return cleaned raw text
    return raw


# ── Core extraction ────────────────────────────────────────────────────────────

def extract_fields(image_bytes):
    """
    Run PaddleOCR on image_bytes and extract AWB fields.
    Returns dict with keys: fields, confidence, raw_blocks.
    """
    import numpy as np
    from PIL import Image

    img = Image.open(io.BytesIO(image_bytes)).convert('RGB')

    # Mild upscale if image is small — helps OCR accuracy
    w, h = img.size
    if max(w, h) < 1200:
        scale = 1200 / max(w, h)
        img = img.resize((int(w*scale), int(h*scale)), Image.LANCZOS)

    img_np = np.array(img)

    ocr = get_ocr()
    result = ocr.ocr(img_np, cls=True)

    # Flatten PaddleOCR result structure
    # result = [ [ [bbox, (text, score)], ... ] ] (one list per image)
    blocks = []
    if result and result[0]:
        for line in result[0]:
            bbox, (text, score) = line
            blocks.append((text.strip(), bbox, score))

    log.info(f'OCR found {len(blocks)} text blocks')

    fields     = {}
    confidence = {}

    for field_key, rule in ANCHORS.items():
        mode = rule['mode']

        if mode == 'pattern_scan':
            value, bbox, score = pattern_scan(blocks, rule['pattern'])
            if value:
                value = value.replace(' ', '').replace('–', '-').replace('—', '-')

        elif mode in ('right_or_below', 'right_or_below_multi'):
            anchor = find_anchor_block(blocks, rule['anchors'])
            if anchor is None:
                fields[field_key]     = None
                confidence[field_key] = 0.0
                continue
            _, anchor_bbox, _ = anchor

            if mode == 'right_or_below_multi':
                value = collect_cell_text(anchor_bbox, blocks)
                score = 0.65   # description is always uncertain
            else:
                value, bbox, score = find_nearest_right_or_below(
                    anchor_bbox, blocks, rule['pattern'],
                    exclude_bbox=anchor_bbox,
                )
                # Validator gate
                if value and rule.get('validator') == 'not_purely_numeric':
                    if re.fullmatch(r'[\d.,]+', value):
                        value = None

                if value and 'cast' in rule:
                    try:
                        value = rule['cast'](value.replace(',', '.'))
                    except (ValueError, TypeError):
                        value = None

        else:
            log.warning(f'Unknown mode {mode} for field {field_key}')
            continue

        # Post-process
        if field_key == 'flight_date' and value:
            value = normalize_date(value)
        if field_key == 'destination' and value:
            value = normalize_destination(value)
        if field_key == 'waybill_number' and value:
            value = re.sub(r'[\s–—]', '-', value)

        fields[field_key]     = value
        confidence[field_key] = compute_field_confidence(score, value, field_key)

    # Use gross_weight as weight if chargeable_weight missing
    if not fields.get('chargeable_weight') and fields.get('gross_weight'):
        fields['chargeable_weight']     = fields['gross_weight']
        confidence['chargeable_weight'] = confidence.get('gross_weight', 0.0) * 0.9

    log.info(f'Extracted: { {k: v for k,v in fields.items() if v is not None} }')

    return {
        'fields':      fields,
        'confidence':  confidence,
        'raw_blocks':  [(text, score) for text, _, score in blocks],
    }


# ── HTTP server ────────────────────────────────────────────────────────────────

def get_secret():
    try:
        return Path(SECRET_FILE).read_text().strip()
    except Exception:
        return None


class OCRHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log.info(fmt % args)

    def send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', len(body))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, x-api-key')
        self.end_headers()

    def do_GET(self):
        if self.path == '/status':
            # Report whether model is loaded
            self.send_json(200, {
                'ok':          True,
                'model_ready': _ocr is not None,
                'port':        PORT,
            })
        else:
            self.send_json(404, {'error': 'Not found'})

    def do_POST(self):
        secret = get_secret()
        if secret and self.headers.get('x-api-key') != secret:
            self.send_json(403, {'error': 'Unauthorized'})
            return

        if self.path == '/ocr':
            length = int(self.headers.get('Content-Length', 0))
            raw    = self.rfile.read(length)
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                self.send_json(400, {'error': 'Invalid JSON'})
                return

            b64 = body.get('image', '')
            if not b64:
                self.send_json(400, {'error': 'Missing image field'})
                return

            try:
                image_bytes = base64.b64decode(b64)
            except Exception:
                self.send_json(400, {'error': 'Invalid base64'})
                return

            try:
                result = extract_fields(image_bytes)
                self.send_json(200, result)
            except Exception as e:
                log.exception('OCR failed')
                self.send_json(500, {'error': str(e)})

        elif self.path == '/warmup':
            # Pre-load model without processing an image
            threading.Thread(target=get_ocr, daemon=True).start()
            self.send_json(200, {'ok': True, 'message': 'Warming up model...'})

        else:
            self.send_json(404, {'error': 'Not found'})


def main():
    import socket
    # Generate secret if missing
    secret_path = Path(SECRET_FILE)
    if not secret_path.exists():
        secret_path.parent.mkdir(parents=True, exist_ok=True)
        import secrets
        secret_path.write_text(secrets.token_hex(32))
        log.info(f'Generated OCR agent secret at {SECRET_FILE}')

    server = http.server.HTTPServer(('127.0.0.1', PORT), OCRHandler)
    log.info(f'OCR agent listening on 127.0.0.1:{PORT}')

    # Warm up model in background so first OCR request is fast
    threading.Thread(target=get_ocr, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info('Shutting down.')
        server.shutdown()


if __name__ == '__main__':
    main()
