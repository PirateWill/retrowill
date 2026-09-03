/* load-binjgb.js
 *
 * Loads the binjgb Game Boy emulator into the browser, picking the best
 * available build for the current device:
 *
 *   1. WebAssembly build  (docs/binjgb.js + docs/binjgb.wasm)
 *      -> used on modern browsers.
 *   2. asm.js build       (docs/binjgb_asm.js + docs/binjgb_asm.js.mem)
 *      -> genuine `"use asm"` fallback, used on older browsers such as
 *         iOS 12 (which lacks reliable WebAssembly).
 *
 * Both builds are created from the same C source with Emscripten and expose
 * the same exported functions, so callers get an identical Module object.
 * This loader also normalises the (slightly different) factory conventions the
 * two Emscripten versions produce:
 *
 *   - WebAssembly build:  const M = await Binjgb();
 *   - asm.js build:       const M = Binjgb({ locateFile: ... });
 *
 * Usage:
 *   const Module = await loadBinjgb();
 *   // Module._emulator_new_simple(...), Module.HEAPU8, ...
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // Feature detection: can this browser usefully run WebAssembly?
  // ------------------------------------------------------------------
  function hasWebAssembly() {
    if (typeof WebAssembly !== 'object') return false;
    if (typeof WebAssembly.instantiate !== 'function') return false;
    if (typeof WebAssembly.Memory !== 'function') return false;

    // iOS 12.0 and 12.1 shipped a WebAssembly implementation with serious
    // stability/performance bugs. Pin them to the asm.js fallback regardless.
    var ua = (navigator.userAgent || '');
    var m = /OS (\d+)[_.](\d+)/.exec(ua);
    if (ua.indexOf('like Mac OS X') !== -1 && ua.indexOf('AppleWebKit') !== -1 && m) {
      var major = parseInt(m[1], 10);
      var minor = parseInt(m[2], 10);
      if (major === 12 && (isNaN(minor) || minor <= 1)) {
        return false; // iOS 12.0 / 12.1 -> use asm.js
      }
    }

    return true;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(script);
    });
  }

  function loadWasmModule() {
    return loadScript('binjgb.js').then(function () {
      // The WASM build returns a Promise that resolves to the Module.
      return global.Binjgb();
    });
  }

  function loadAsmJsModule() {
    return loadScript('binjgb_asm.js').then(function () {
      // The asm.js build returns the Module synchronously.
      var Module = global.Binjgb({
        locateFile: function (path) { return path; }
      });
      return Promise.resolve(Module);
    });
  }

  var cached = null;

  function loadBinjgb() {
    if (cached) return cached;

    var engine = hasWebAssembly() ? 'wasm' : 'asmjs';
    console.log('[binjgb] using ' + engine + ' build (WebAssembly support: ' + !!hasWebAssembly() + ')');

    cached = (engine === 'wasm' ? loadWasmModule() : loadAsmJsModule())
      .then(function (Module) {
        Module.__engine = engine; // tag for diagnostics
        return Module;
      })
      .catch(function (e) {
        // If the WASM build fails for any reason, fall through to asm.js.
        if (engine === 'wasm') {
          console.warn('[binjgb] WASM build failed, falling back to asm.js:', e);
          return loadAsmJsModule();
        }
        throw e;
      });

    return cached;
  }

  global.loadBinjgb = loadBinjgb;
})(this);
