import os
import json
from pathlib import Path
from datetime import datetime

import mimetypes
from flask import Flask, request, jsonify, send_file, abort
from flask_cors import CORS
from werkzeug.utils import secure_filename
try:
    from PIL import Image
    PIL_AVAILABLE = True
except Exception:
    Image = None
    PIL_AVAILABLE = False
import subprocess
import shutil

# Define base directory and storage paths
BASE_DIR = Path(__file__).resolve().parent
STORAGE_ROOT = BASE_DIR / "storage"
RULES_FILE = BASE_DIR / "rules.json"

# Initialize Flask app and enable CORS
app = Flask(__name__)
CORS(app)

# Ensure the storage directory exists
STORAGE_ROOT.mkdir(parents=True, exist_ok=True)

# Thumbnail storage (inside STORAGE_ROOT so it is accessible via existing view/download)
THUMB_ROOT = STORAGE_ROOT / ".thumbnails"
THUMB_ROOT.mkdir(parents=True, exist_ok=True)

# ==========================
# HELPER FUNCTIONS
# ==========================

def load_custom_rules():
    """
    Load custom file categorization rules from the rules.json file.
    Returns an empty dictionary if the file doesn't exist or fails to load.
    """
    if RULES_FILE.is_file():
        try:
            return json.loads(RULES_FILE.read_text())
        except Exception:
            return {}
    return {}


def generate_image_thumbnail(src_path: Path, dst_path: Path, size=(320, 240)) -> bool:
    try:
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(src_path) as im:
            # convert to RGB for consistent JPEG output
            if im.mode != "RGB":
                im = im.convert("RGB")
            im.thumbnail(size)
            im.save(dst_path, format="JPEG", quality=85)
        return True
    except Exception:
        return False


def generate_video_thumbnail(src_path: Path, dst_path: Path, time_offset="00:00:01", size=(320, -2)) -> bool:
    """Try to extract a single frame from video using ffmpeg (if available).

    `size` should be (width, height) where -2 keeps aspect ratio. The dst will be a JPG.
    Returns True if thumbnail created.
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False

    dst_path.parent.mkdir(parents=True, exist_ok=True)
    # build scale filter
    width = size[0]
    scale = f"scale={width}:-2" if width and width > 0 else "scale=320:-2"
    cmd = [
        ffmpeg,
        "-y",
        "-ss",
        time_offset,
        "-i",
        str(src_path),
        "-frames:v",
        "1",
        "-vf",
        scale,
        str(dst_path),
    ]
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return dst_path.is_file()
    except Exception:
        return False

def make_unique_filename(directory: Path, filename: str) -> Path:
    base = Path(filename).stem
    ext = Path(filename).suffix
    counter = 1
    new_name = filename

    while (directory / new_name).exists():
        new_name = f"{base} ({counter}){ext}"
        counter += 1

    return directory / new_name


def generate_thumbnail(file_path: Path):
    """Create a JPEG thumbnail for images and videos under THUMB_ROOT mirroring folder structure."""
    rel = file_path.relative_to(STORAGE_ROOT)
    thumb_path = THUMB_ROOT / rel
    thumb_path = thumb_path.with_suffix('.jpg')

    ext = file_path.suffix.lower()
    image_exts = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff'}
    video_exts = {'.mp4', '.mov', '.avi', '.mkv', '.wmv', '.webm'}

    if ext in image_exts:
        return generate_image_thumbnail(file_path, thumb_path)
    if ext in video_exts:
        return generate_video_thumbnail(file_path, thumb_path)
    return False


def save_custom_rules(rules):
    RULES_FILE.write_text(json.dumps(rules, indent=2))


def categorize_file(filename: str, custom_rules: dict) -> str:
    """
    Decide which folder a file should go in based on extension.
    Custom rules > built-in groups > 'EXT Files' > 'Other'
    """
    ext = Path(filename).suffix.lower()

    # 1. Custom rules
    for folder, exts in custom_rules.items():
        if ext in exts:
            return folder

    # 2. Built-in mapping
    groups = {
        "MS Word": [".doc", ".docx", ".rtf", ".odt"],
        "MS Excel": [".xls", ".xlsx", ".csv"],
        "PDF": [".pdf"],
        "PowerPoint": [".ppt", ".pptx"],
        "Images": [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff"],
        "Audio": [".mp3", ".wav", ".aac", ".flac", ".ogg", ".m4a"],
        "Video": [".mp4", ".mov", ".avi", ".mkv", ".wmv", ".webm"],
        "Text": [".txt", ".md", ".log"],
        "Archives": [".zip", ".rar", ".7z", ".tar", ".gz"],
    }

    for folder, exts in groups.items():
        if ext in exts:
            return folder

    # 3. New extension → its own folder, e.g. "JSON Files"
    if ext:
        return ext.lstrip(".").upper() + " Files"

    # 4. No extension
    return "Other"


def build_file_info(path: Path) -> dict:
    stat = path.stat()
    rel_path = path.relative_to(STORAGE_ROOT)
    parts = rel_path.parts
    category = parts[0] if len(parts) > 1 else "Uncategorized"

    # check for thumbnail in the thumbnails tree
    thumb_rel = None
    try:
        thumb_candidate = THUMB_ROOT / rel_path
        # thumbnails are saved as JPG
        thumb_candidate = thumb_candidate.with_suffix('.jpg')
        if thumb_candidate.is_file():
            thumb_rel = thumb_candidate.relative_to(STORAGE_ROOT).as_posix()
    except Exception:
        thumb_rel = None

    return {
        "name": path.name,
        "relative_path": str(rel_path).replace("\\", "/"),
        "category": category,
        "thumbnail": thumb_rel,
        "size_bytes": stat.st_size,
        "created_time": datetime.fromtimestamp(stat.st_ctime).isoformat(),
        "last_access_time": datetime.fromtimestamp(stat.st_atime).isoformat(),
        "modified_time": datetime.fromtimestamp(stat.st_mtime).isoformat(),
    }


# ==========================
# ROUTES
# ==========================

@app.route("/health")
def health():
    return jsonify({"status": "ok", "message": "SmartDrive backend running!"})


@app.route("/upload", methods=["POST"])
def upload():
    custom_rules = load_custom_rules()

    files = request.files.getlist("file")
    if not files:
        return jsonify({"success": False, "message": "No files uploaded."}), 400

    saved = []

    for f in files:
        if not f or f.filename == "":
            continue

        filename = secure_filename(f.filename)
        category = categorize_file(filename, custom_rules)

        target_dir = STORAGE_ROOT / category
        target_dir.mkdir(parents=True, exist_ok=True)

        # SAFE FILENAME
        target_path = make_unique_filename(target_dir, filename)

        f.save(target_path)

        try:
            generate_thumbnail(target_path)
        except Exception:
            pass

        saved.append(build_file_info(target_path))

    return jsonify({
        "success": True,
        "message": f"Uploaded {len(saved)} file(s).",
        "files": saved,
    })

@app.route("/files", methods=["GET"])
def list_files():
    results = []
    for root, _, files in os.walk(STORAGE_ROOT):
        root_path = Path(root).resolve()
        # skip thumbnails directory
        try:
            if THUMB_ROOT.resolve() == root_path or THUMB_ROOT.resolve() in root_path.parents:
                continue
        except Exception:
            pass

        for name in files:
            path = Path(root) / name
            results.append(build_file_info(path))
    return jsonify({"files": results})


def safe_resolve_relpath(rel_path: str) -> Path:
    """
    Convert 'MS Word/report.docx' → absolute path, ensure it stays inside STORAGE_ROOT.
    """
    joined = STORAGE_ROOT / rel_path
    resolved = joined.resolve()

    try:
        resolved.relative_to(STORAGE_ROOT)
    except ValueError:
        abort(400, description="Invalid path")

    return resolved


@app.route("/download", methods=["GET", "HEAD"])
def download():
    rel_path = request.args.get("path")
    if not rel_path:
        abort(400, description="Missing path parameter")

    file_path = safe_resolve_relpath(rel_path)

    if not file_path.is_file():
        abort(404, description="File not found")

    if request.method == "HEAD":
        return ("", 200)

    return send_file(file_path, as_attachment=True)


@app.route("/view", methods=["GET", "HEAD"])
def view_file():
    """Serve a file for inline viewing (no attachment). Uses correct Content-Type.

    Note: this differs from `/download` which forces an attachment.
    """
    rel_path = request.args.get("path")
    if not rel_path:
        abort(400, description="Missing path parameter")

    file_path = safe_resolve_relpath(rel_path)

    if not file_path.is_file():
        abort(404, description="File not found")

    if request.method == "HEAD":
        return ("", 200)

    # Try to guess mimetype; fall back to octet-stream
    mimetype, _ = mimetypes.guess_type(str(file_path))
    return send_file(file_path, mimetype=(mimetype or "application/octet-stream"), as_attachment=False)


@app.route("/delete", methods=["DELETE"])
def delete():
    rel_path = request.args.get("path")
    if not rel_path:
        return jsonify({"success": False, "message": "Missing path parameter"}), 400

    file_path = safe_resolve_relpath(rel_path)

    if not file_path.is_file():
        return jsonify({"success": False, "message": "File not found"}), 404

    # remove the file
    file_path.unlink()

    # also remove any generated thumbnail
    try:
        rel = file_path.relative_to(STORAGE_ROOT)
        thumb = THUMB_ROOT / rel
        thumb = thumb.with_suffix('.jpg')
        if thumb.is_file():
            thumb.unlink()
    except Exception:
        pass

    return jsonify({"success": True, "message": "File deleted."})


@app.route("/rules", methods=["GET", "POST"])
def rules():
    if request.method == "GET":
        return jsonify({"custom_rules": load_custom_rules()})

    data = request.get_json(silent=True) or {}
    folder = data.get("folder", "").strip()
    extensions = data.get("extensions", [])

    if not folder or not isinstance(extensions, list):
        return jsonify({"success": False, "message": "Invalid rule data."}), 400

    norm_exts = []
    for ext in extensions:
        e = ext.strip().lower()
        if not e:
            continue
        if not e.startswith("."):
            e = "." + e
        norm_exts.append(e)

    rules = load_custom_rules()
    rules[folder] = norm_exts
    save_custom_rules(rules)

    return jsonify({"success": True, "custom_rules": rules})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
