// === CONFIG ===
const BACKEND_URL = "http://127.0.0.1:5000"; // Flask backend

// === DOM ELEMENTS ===
const dropArea = document.getElementById("drop-area");
const fileElem = document.getElementById("fileElem");
const fileList = document.getElementById("file-list");
const searchBox = document.getElementById("search");
const sortSelect = document.getElementById("sort");
const backBtn = document.getElementById("back-btn");
const currentPath = document.getElementById("current-path");

// === STATE ===
let filesArray = [];        // all files from backend
let currentFolder = "Home";
let folderStack = [];

// Helper: convert backend file JSON to frontend object
function mapServerFile(f) {
  return {
    name: f.name,
    size: f.size_bytes,
    date: new Date(f.created_time),
    type: f.category,
    folder: f.category,      // use category as folder
    serverPath: f.relative_path
  };
}

// ========== INITIAL LOAD ==========

async function loadFilesFromBackend() {
  try {
    const res = await fetch(`${BACKEND_URL}/files`);
    const data = await res.json();
    filesArray = (data.files || []).map(mapServerFile);
    displayFolders();
  } catch (err) {
    console.error("Error loading files:", err);
  }
}

window.addEventListener("DOMContentLoaded", loadFilesFromBackend);

// ========== DRAG & DROP / FILE SELECT ==========

dropArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropArea.style.background = "#e9f5ff";
});

dropArea.addEventListener("dragleave", () => {
  dropArea.style.background = "white";
});

dropArea.addEventListener("drop", (e) => {
  e.preventDefault();
  dropArea.style.background = "white";
  const files = [...e.dataTransfer.files];
  handleFiles(files);
});

fileElem.addEventListener("change", (e) => {
  handleFiles([...e.target.files]);
});

// Handle selected/dropped files: upload each to backend
function handleFiles(files) {
  files.forEach((file) => {
    uploadFileToBackend(file);
  });
}

// Upload a single file to Flask /upload
async function uploadFileToBackend(file) {
  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch(`${BACKEND_URL}/upload`, {
      method: "POST",
      body: formData
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      alert(`Upload failed for ${file.name}: ${data.message || res.status}`);
      return;
    }

    // Add returned file info to filesArray
    const mapped = mapServerFile(data.file);
    filesArray.push(mapped);
    displayFolders();

  } catch (err) {
    console.error("Upload error:", err);
    alert(`Upload error for ${file.name}`);
  }
}

// ========== FOLDER / FILE DISPLAY ==========

function displayFolders() {
  fileList.innerHTML = "";
  currentPath.textContent = currentFolder;

  // Get current sorting
  const sortBy = sortSelect ? sortSelect.value : "name";

  // We always work from full filesArray
  let workingArray = [...filesArray];

  // Sort according to selection
  workingArray.sort((a, b) => {
    if (sortBy === "size") {
      return a.size - b.size;
    } else if (sortBy === "date") {
      return a.date - b.date;
    } else {
      // default: name
      return a.name.localeCompare(b.name);
    }
  });

  if (currentFolder === "Home") {
    // Show all unique folders (categories)
    const folderNames = [...new Set(workingArray.map(f => f.folder))];

    folderNames.forEach(folder => {
      const div = document.createElement("div");
      div.classList.add("item");
      div.innerHTML = `
        <div class="folder-icon">📁</div>
        <div class="item-name">${folder}</div>
      `;
      div.addEventListener("click", () => openFolder(folder));
      fileList.appendChild(div);
    });

  } else {
    // Show files inside the selected folder
    const folderFiles = workingArray.filter(f => f.folder === currentFolder);

    folderFiles.forEach(file => {
      const div = document.createElement("div");
      div.classList.add("item");
      div.innerHTML = `
        <div class="item-name">${file.name}</div>
        <div class="item-meta">${(file.size / 1024).toFixed(1)} KB</div>
      `;

      // Single click -> download from backend
      div.addEventListener("click", () => {
        const encodedPath = encodeURIComponent(file.serverPath);
        const url = `${BACKEND_URL}/download/${encodedPath}`;
        window.open(url, "_blank");
      });

      fileList.appendChild(div);
    });
  }
}

// ========== FOLDER NAVIGATION ==========

function openFolder(folder) {
  folderStack.push(currentFolder);
  currentFolder = folder;
  backBtn.disabled = false;
  displayFolders();
}

backBtn.addEventListener("click", () => {
  if (folderStack.length > 0) {
    currentFolder = folderStack.pop();
    if (currentFolder === "Home") backBtn.disabled = true;
    displayFolders();
  }
});

// ========== SEARCH ==========

searchBox.addEventListener("input", () => {
  const query = searchBox.value.toLowerCase().trim();

  if (query === "") {
    // reset view
    currentFolder = "Home";
    folderStack = [];
    displayFolders();
    return;
  }

  currentFolder = "Home";
  folderStack = [];

  const results = filesArray.filter(f =>
    f.name.toLowerCase().includes(query)
  );

  fileList.innerHTML = "";
  currentPath.textContent = `Search: "${query}"`;

  results.forEach(file => {
    const div = document.createElement("div");
    div.classList.add("item");
    div.innerHTML = `
      <div class="item-name">${file.name}</div>
      <div class="item-meta">${file.folder}</div>
    `;
    div.addEventListener("click", () => {
      const encodedPath = encodeURIComponent(file.serverPath);
      const url = `${BACKEND_URL}/download/${encodedPath}`;
      window.open(url, "_blank");
    });
    fileList.appendChild(div);
  });
});

// ========== SORT CHANGE ==========

if (sortSelect) {
  sortSelect.addEventListener("change", displayFolders);
}
