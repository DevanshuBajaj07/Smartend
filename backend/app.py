import os
from pathlib import Path
from datetime import datetime

from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from werkzeug.utils import secure_filename

app = Flask(__name__)
CORS(app)

# ====== CONFIG ======
BASE_DIR = Path(__file__).resolve().parent
STORAGE_ROOT = BASE_DIR / "storage"

# Make sure storage folder exists
STORAGE_ROOT.mkdir(exist_ok=True)

# Map file extensions to folder names
EXTENSION_MAP = {
    ".doc": "word",
    ".docx": "word",
    ".pdf": "pdf",
    ".xls": "excel",
    ".xlsx": "excel",
    ".ppt": "powerpoint",
    ".pptx": "powerpoint",
    ".mp3": "audio",
    ".wav": "audio",
    ".mp4": "video",
    ".mov": "video",
    ".avi": "video",
    ".png": "images",
    ".jpg": "images",
    ".jpeg": "images",
    ".txt": "text"
}

def get_category_for_extension(ext: str) -> str:
    """
    Decide folder for a given file extension.
    If unknown, create a folder with the extension name.
    """
    ext = ext.lower()
    if ext in EXTENSION_MAP:
        return EXTENSION_MAP[ext]
    return ext.lstrip(".") or "others"


@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({"status": "ok", "message": "SmartDrive backend running!"})


@app.route("/upload", methods=["POST"])
def upload_file():
    if "file" not in request.files:
        return jsonify({"success": False, "message": "No file found"}), 400

    file = request.files["file"]

    if file.filename == "":
        return jsonify({"success": False, "message": "Empty filename"}), 400

    filename = secure_filename(file.filename)
    _, ext = os.path.splitext(filename)

    category = get_category_for_extension(ext)

    # Ensure category folder exists
    category_path = STORAGE_ROOT / category
    category_path.mkdir(exist_ok=True)

    save_path = category_path / filename

    try:
        file.save(save_path)
    except Exception as e:
        return jsonify({"success": False, "message": f"Error saving file: {e}"}), 500

    stats = save_path.stat()

    return jsonify({
        "success": True,
        "message": "File uploaded successfully",
        "file": {
            "name": filename,
            "category": category,
            "size_bytes": stats.st_size,
            "created_time": datetime.fromtimestamp(stats.st_ctime).isoformat(),
            "last_access_time": datetime.fromtimestamp(stats.st_atime).isoformat(),
            "relative_path": f"{category}/{filename}"
        }
    })


@app.route("/files", methods=["GET"])
def list_files():
    files = []

    for cat_folder in STORAGE_ROOT.iterdir():
        if cat_folder.is_dir():
            for file_path in cat_folder.iterdir():
                if file_path.is_file():
                    stats = file_path.stat()
                    files.append({
                        "name": file_path.name,
                        "category": cat_folder.name,
                        "size_bytes": stats.st_size,
                        "created_time": datetime.fromtimestamp(stats.st_ctime).isoformat(),
                        "last_access_time": datetime.fromtimestamp(stats.st_atime).isoformat(),
                        "relative_path": f"{cat_folder.name}/{file_path.name}"
                    })

    return jsonify({"files": files})


@app.route("/download/<path:relpath>", methods=["GET"])
def download(relpath):
    file_path = STORAGE_ROOT / relpath

    if not file_path.exists():
        return jsonify({"success": False, "message": "File not found"}), 404

    return send_file(file_path, as_attachment=True)


if __name__ == "__main__":
    app.run(debug=True, port=5000)