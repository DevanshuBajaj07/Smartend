import os
import json
import io
import zipfile
import mimetypes
import shutil
from pathlib import Path
from datetime import datetime

from flask import Flask, request, jsonify, send_file, abort
from flask_cors import CORS
from werkzeug.utils import secure_filename

try:
    from PIL import Image
    PIL_AVAILABLE = True
except Exception:  # optional dependency
    Image = None
    PIL_AVAILABLE = False

# ==========================
# PATHS & CONFIG
# ==========================

BASE_DIR = Path(__file__).resolve().parent
STORAGE_ROOT = BASE_DIR / "storage"
RULES_FILE = BASE_DIR / "rules.json"

# Ensure storage exists
STORAGE_ROOT.mkdir(parents=True, exist_ok=True)

# Thumbnails live inside STORAGE_ROOT so existing /view & /download can serve them
THUMB_ROOT = STORAGE_ROOT / ".thumbnails"
THUMB_ROOT.mkdir(parents=True, exist_ok=True)

# Optional "quota" just for the UI storage bar (10 GB default, override with env)
MAX_STORAGE_BYTES = int(os.environ.get("SMARTDRIVE_MAX_BYTES", str(10 * 1024 * 1024 * 1024)))

app = Flask(__name__)
CORS(app)


# ==========================
# HELPER FUNCTIONS
# ==========================

def load_custom_rules() -> dict:
    """
    Load custom file categorization rules from rules.json.
    Structure:
    {
        "CAD": [".dwg", ".dxf"],
        "Design": [".psd", ".ai"]
    }
    """
    if RULES_FILE.is_file():
        try:
            return json.loads(RULES_FILE.read_text())
        except Exception:
            return {}
    return {}


def save_custom_rules(rules: dict) -> None:
    """Persist custom rules to rules.json in pretty JSON."""
    try:
        RULES_FILE.write_text(json.dumps(rules, indent=2))
    except Exception:
        # Failing to save rules should not crash the app
        pass


def normalize_extension(ext: str) -> str:
    """Ensure extension is lowercase and starts with a dot."""
    if not ext:
        return ""
    ext = ext.strip().lower()
    if not ext:
        return ""
    if not ext.startswith("."):
        ext = "." + ext
    return ext


def categorize_file(filename: str, custom_rules: dict | None = None) -> str:
    """
    Decide which folder a file should go in based on extension.
    Custom rules > built-in groups > 'EXT Files' > 'Other'
    """
    ext = Path(filename).suffix.lower()
    rules = custom_rules or load_custom_rules()

    # 1. Custom rules
    for folder, exts in rules.items():
        try:
            if ext in [normalize_extension(e) for e in exts]:
                return folder
        except Exception:
            continue

    # 2. Built-in mapping
    groups = {
        "MS Word": [".doc", ".docx", ".rtf", ".odt"],
        "MS Excel": [".xls", ".xlsx", ".csv"],
        "PDF": [".pdf"],
        "Images": [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff"],
        "Audio": [".mp3", ".wav", ".ogg", ".flac", ".m4a"],
        "Video": [".mp4", ".mov", ".avi", ".mkv", ".webm"],
        "Text": [".txt", ".log", ".md"],
        "Code": [
            ".py", ".js", ".ts", ".html", ".css", ".json", ".yml", ".yaml",
            ".java", ".c", ".cpp", ".cs", ".go", ".rs", ".php", ".sh", ".bat",
        ],
        "Archives": [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2"],
        "Executables": [".exe", ".msi", ".bin", ".appimage"],
    }

    for folder, exts in groups.items():
        if ext in exts:
            return folder

    # 3. Fallback: "EXT Files" based on extension
    if ext:
        return f"{ext[1:].upper()} Files"

    # 4. Completely unknown (no extension)
    return "Other"


def safe_resolve_relpath(rel_path: str) -> Path:
    """
    Safely resolve a relative path under STORAGE_ROOT.
    Prevents path traversal (../../etc/passwd).
    """
    rel_path = rel_path.lstrip("/").replace("\\", "/")
    candidate = (STORAGE_ROOT / rel_path).resolve()
    storage_root = STORAGE_ROOT.resolve()

    # candidate must be inside storage_root
    if candidate != storage_root and storage_root not in candidate.parents:
        abort(400, description="Invalid path")
    return candidate


def build_file_info(path: Path) -> dict:
    """Return metadata for a file suitable for the frontend."""
    stat = path.stat()
    rel_path = path.relative_to(STORAGE_ROOT)
    parts = rel_path.parts
    category = parts[0] if len(parts) > 1 else "Uncategorized"

    # check for thumbnail in the thumbnails tree
    thumb_rel = None
    try:
        thumb_candidate = THUMB_ROOT / rel_path
        # thumbnails are saved as JPG by convention
        thumb_candidate = thumb_candidate.with_suffix(".jpg")
        if thumb_candidate.is_file():
            thumb_rel = thumb_candidate.relative_to(STORAGE_ROOT).as_posix()
    except Exception:
        thumb_rel = None

    return {
        "name": path.name,
        "relative_path": rel_path.as_posix(),
        "category": category,
        "thumbnail": thumb_rel,
        "size_bytes": stat.st_size,
        "created_time": datetime.fromtimestamp(stat.st_ctime).isoformat(),
        "last_access_time": datetime.fromtimestamp(stat.st_atime).isoformat(),
        "modified_time": datetime.fromtimestamp(stat.st_mtime).isoformat(),
    }


def iter_storage_files():
    """
    Yield Path objects for all files under STORAGE_ROOT,
    skipping the .thumbnails tree.
    """
    try:
        thumb_root_resolved = THUMB_ROOT.resolve()
    except Exception:
        thumb_root_resolved = None

    for root, _, files in os.walk(STORAGE_ROOT):
        root_path = Path(root).resolve()

        # Skip thumbnails directory
        try:
            if thumb_root_resolved and (
                root_path == thumb_root_resolved or thumb_root_resolved in root_path.parents
            ):
                continue
        except Exception:
            pass

        for name in files:
            yield Path(root) / name


def save_uploaded_file(f, custom_rules: dict | None = None) -> Path:
    """
    Save an uploaded file into STORAGE_ROOT in the proper category, handling
    filename collisions by appending a numeric suffix.
    Returns the final file path.
    """
    original_name = f.filename or "uploaded"
    filename = secure_filename(original_name)
    if not filename:
        filename = "uploaded"

    folder = categorize_file(filename, custom_rules=custom_rules)
    target_dir = STORAGE_ROOT / folder
    target_dir.mkdir(parents=True, exist_ok=True)

    stem = Path(filename).stem
    ext = Path(filename).suffix

    candidate = target_dir / filename
    counter = 1
    while candidate.exists():
        candidate = target_dir / f"{stem} ({counter}){ext}"
        counter += 1

    f.save(candidate)

    # Optional: generate thumbnail for images (if Pillow is installed)
    if PIL_AVAILABLE:
        try:
            generate_thumbnail(candidate)
        except Exception:
            # Thumbnail failure should not block upload
            pass

    return candidate


def generate_thumbnail(path: Path, size=(240, 180)) -> None:
    """Generate an image thumbnail parallel to the file path under THUMB_ROOT."""
    if not PIL_AVAILABLE:
        return

    # Only bother for typical image formats
    image_exts = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff"}
    if path.suffix.lower() not in image_exts:
        return

    rel = path.relative_to(STORAGE_ROOT)
    thumb_path = (THUMB_ROOT / rel).with_suffix(".jpg")
    thumb_path.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(path) as img:
        img.thumbnail(size)
        img.convert("RGB").save(thumb_path, format="JPEG", quality=80)


# ==========================
# ROUTES
# ==========================

@app.route("/health", methods=["GET"])
def health():
    """Simple health check used by the frontend."""
    return jsonify({"status": "ok"})


@app.route("/files", methods=["GET"])
def list_files():
    """Return metadata for all files for the browser UI."""
    results = [build_file_info(path) for path in iter_storage_files()]
    return jsonify({"files": results})


@app.route("/stats", methods=["GET"])
def stats():
    """
    Return simple storage statistics so the frontend can draw a usage bar.
    - total_bytes: sum of all file sizes (excluding thumbnails)
    - total_files: number of files
    - max_bytes: configured max/quota (for percentage)
    """
    total_bytes = 0
    total_files = 0

    for path in iter_storage_files():
        try:
            st = path.stat()
        except FileNotFoundError:
            continue
        total_files += 1
        total_bytes += st.st_size

    return jsonify(
        {
            "total_bytes": total_bytes,
            "total_files": total_files,
            "max_bytes": MAX_STORAGE_BYTES,
        }
    )


@app.route("/upload", methods=["POST"])
def upload():
    """
    Handle file uploads.
    Accepts multiple files via 'file' field.
    """
    if "file" not in request.files:
        return jsonify({"success": False, "message": "No file part in the request"}), 400

    files = request.files.getlist("file")
    files = [f for f in files if f.filename]

    if not files:
        return jsonify({"success": False, "message": "No selected file(s)"}), 400

    rules = load_custom_rules()

    saved_paths = []
    for f in files:
        saved = save_uploaded_file(f, custom_rules=rules)
        saved_paths.append(saved.relative_to(STORAGE_ROOT).as_posix())

    message = f"Uploaded {len(saved_paths)} file(s)."
    return jsonify({"success": True, "message": message, "paths": saved_paths})


@app.route("/view", methods=["GET"])
def view_file():
    """
    Stream a file for inline viewing (image, pdf, text, etc.).
    Used by the preview modal in the frontend.
    """
    rel_path = request.args.get("path")
    if not rel_path:
        abort(400, description="Missing path parameter")

    file_path = safe_resolve_relpath(rel_path)

    if not file_path.is_file():
        abort(404, description="File not found")

    mime_type, _ = mimetypes.guess_type(file_path.name)
    if mime_type is None:
        mime_type = "application/octet-stream"

    return send_file(file_path, mimetype=mime_type)


@app.route("/download", methods=["GET", "HEAD"])
def download():
    """
    Download a single file. HEAD is used by the frontend to verify existence.
    """
    rel_path = request.args.get("path")
    if not rel_path:
        abort(400, description="Missing path parameter")

    file_path = safe_resolve_relpath(rel_path)

    if not file_path.is_file():
        abort(404, description="File not found")

    if request.method == "HEAD":
        # Just confirm file exists
        return "", 200

    return send_file(
        file_path,
        as_attachment=True,
        download_name=file_path.name,
    )


@app.route("/download_folder", methods=["GET"])
def download_folder():
    """
    Zip an entire folder (category) and return it as a single download.
    The frontend sends ?folder=<folderName>, which is treated as a relative
    path under STORAGE_ROOT, e.g. "PDF" or "MS Word".
    """
    folder_rel = request.args.get("folder", "").strip()
    if not folder_rel:
        abort(400, description="Missing folder parameter")

    # Resolve folder path safely inside STORAGE_ROOT
    folder_path = STORAGE_ROOT / folder_rel
    try:
        folder_path = folder_path.resolve()
        storage_root = STORAGE_ROOT.resolve()
        if folder_path != storage_root and storage_root not in folder_path.parents:
            abort(400, description="Invalid folder path")
    except Exception:
        abort(400, description="Invalid folder path")

    if not folder_path.is_dir():
        abort(404, description="Folder not found")

    mem = io.BytesIO()

    try:
        thumb_root_resolved = THUMB_ROOT.resolve()
    except Exception:
        thumb_root_resolved = None

    with zipfile.ZipFile(mem, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _, files in os.walk(folder_path):
            root_path = Path(root).resolve()

            # Skip thumbnails directory
            try:
                if thumb_root_resolved and (
                    root_path == thumb_root_resolved or thumb_root_resolved in root_path.parents
                ):
                    continue
            except Exception:
                pass

            for name in files:
                file_path = Path(root) / name
                try:
                    arcname = file_path.relative_to(folder_path.parent)
                except Exception:
                    arcname = file_path.name
                zf.write(file_path, arcname.as_posix())

    mem.seek(0)
    download_name = f"{folder_path.name}.zip"
    return send_file(
        mem,
        as_attachment=True,
        download_name=download_name,
        mimetype="application/zip",
    )


@app.route("/delete", methods=["DELETE"])
def delete_file():
    """Delete a file plus any thumbnail, used by the 'Delete' action in UI."""
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
        thumb = (THUMB_ROOT / rel).with_suffix(".jpg")
        if thumb.is_file():
            thumb.unlink()
    except Exception:
        pass

    # Attempt to clean up empty category folder (optional)
    try:
        parent = file_path.parent
        if parent != STORAGE_ROOT and not any(parent.iterdir()):
            parent.rmdir()
    except Exception:
        pass

    return jsonify({"success": True, "message": "File deleted"})


@app.route("/rules", methods=["GET", "POST"])
def rules():
    """
    GET  -> return existing custom rules
    POST -> add/update a rule for a folder.
            JSON body: { "folder": "CAD", "extensions": ["dwg", "dxf"] }
    """
    if request.method == "GET":
        rules_data = load_custom_rules()
        return jsonify({"custom_rules": rules_data})

    data = request.get_json(silent=True) or {}
    folder = (data.get("folder") or "").strip()
    exts = data.get("extensions") or []

    if not folder or not isinstance(exts, list):
        return (
            jsonify(
                {
                    "success": False,
                    "message": "Invalid payload. Require 'folder' and list 'extensions'.",
                }
            ),
            400,
        )

    norm_exts = []
    for raw in exts:
        e = normalize_extension(str(raw))
        if e:
            norm_exts.append(e)

    if not norm_exts:
        return (
            jsonify(
                {"success": False, "message": "No valid extensions provided."}
            ),
            400,
        )

    rules_data = load_custom_rules()
    rules_data[folder] = norm_exts
    save_custom_rules(rules_data)

    return jsonify({"success": True, "custom_rules": rules_data})


if __name__ == "__main__":
    # 0.0.0.0 ensures the app is reachable on EC2 from the outside
    app.run(host="0.0.0.0", port=5000, debug=True)
