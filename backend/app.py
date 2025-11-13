import os
import json
from pathlib import Path
from datetime import datetime

from flask import Flask, request, jsonify, send_file, abort
from flask_cors import CORS
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent
STORAGE_ROOT = BASE_DIR / "storage"
RULES_FILE = BASE_DIR / "rules.json"

app = Flask(__name__)
CORS(app)

STORAGE_ROOT.mkdir(parents=True, exist_ok=True)


def load_custom_rules():
    if RULES_FILE.is_file():
        try:
            return json.loads(RULES_FILE.read_text())
        except Exception:
            return {}
    return {}


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

    return {
        "name": path.name,
        "relative_path": str(rel_path).replace("\\", "/"),
        "category": category,
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

        target_path = target_dir / filename
        f.save(target_path)

        saved.append(build_file_info(target_path))

    if not saved:
        return jsonify({"success": False, "message": "No valid files uploaded."}), 400

    return jsonify({
        "success": True,
        "message": f"Uploaded {len(saved)} file(s).",
        "files": saved,
    })


@app.route("/files", methods=["GET"])
def list_files():
    results = []
    for root, _, files in os.walk(STORAGE_ROOT):
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


@app.route("/delete", methods=["DELETE"])
def delete():
    rel_path = request.args.get("path")
    if not rel_path:
        return jsonify({"success": False, "message": "Missing path parameter"}), 400

    file_path = safe_resolve_relpath(rel_path)

    if not file_path.is_file():
        return jsonify({"success": False, "message": "File not found"}), 404

    file_path.unlink()

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
