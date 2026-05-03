# KWin Maximize Detector Script

A KWin Script that monitors window maximize/restore events and notifies external applications via D-Bus method calls.

## Installation

1. **Build the package:**
   ```bash
   cmake -S . -B build
   cmake --build build
   ```
   This produces `build/maximize_detector.kwinscript`.

2. **Install from System Settings:**
   - Open System Settings → Apps & Windows → Window Management → KWin Scripts
   - Click "Install from File"
   - Select the generated `maximize_detector.kwinscript` file
   - Enable "Maximize Detector" in the KWin Scripts list

