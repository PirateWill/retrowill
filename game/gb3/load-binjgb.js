/* load-binjgb.js
 *
 * Loads the binjgb Game Boy emulator into the browser, picking the best
 * available build for the current device:
 *
 *   1. WebAssembly build  (docs/binjgb.js + docs/binjgb.wasm)
 *      -> used on modern browsers.
 *   2. asm.js build       (docs/binjgb_asm.js)
 *      -> a genuine `"use asm"` single-file fallback, used on older browsers
 *         such as iOS 12 (which lacks reliable WebAssembly). The memory
 *         initializer is embedded as a data URI, so no extra .mem / XHR is
 *         needed.
 *
 * Both builds are created from the same C source with Emscripten and expose
 * the same exported functions, so callers get an identical Module object.
 * This loader also normalises the (slightly different) factory conventions the
 * two Emscripten versions produce:
 *
 *   - WebAssembly build:  const M = await Binjgb();
 *   - asm.js build:       const M = Binjgb({ locateFile: ... });  // synchronous
 *
 * IMPORTANT PROMISE GOTCHA:
 * The fastcomp asm.js Module object is itself a *thenable* (it has a .then()
 * method used to report runtime readiness). Never resolve a native Promise
 * with that Module directly: Promise/A+ would try to assimilate the thenable,
 * re-invoking Module.then -> resolve(Module) -> ... in an infinite loop that
 * starves the event loop (i.e. "nothing loads"). So loadBinjgb() resolves with
 * a plain, non-thenable box: { Module }.
 *
 * Usage:
 *   loadBinjgb().then(function (box) {
 *     var Module = box.Module;
 *     Module._emulator_new_simple(...); Module.HEAPU8; ...
 *   });
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

  // Wrap a (possibly thenable) Module in a plain, non-thenable box so it can
  // be delivered through Promise resolution without triggering assimilation.
  function boxModule(Module, engine) {
    Module.__engine = engine;
    return { Module: Module };
  }

  // Resolve a promise with the asm.js Module once its runtime is initialised.
  // The module is ready either synchronously (data-URI memory initializer) or
  // shortly after; Module.then() reports both cases. We resolve with a plain
  // box, never with the thenable Module itself (see header note).
  function settleAsmJsModule(Module, engine) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        fail('asm.js runtime did not initialise within 15s');
      }, 15000);
      function fail(msg) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(msg));
      }

      if (!Module || typeof Module.then !== 'function') {
        fail('asm.js module did not expose a ready signal');
        return;
      }
      Module.then(function (readyModule) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(boxModule(readyModule, engine)); // plain box, not the thenable
      });
    });
  }

  function loadWasmModule() {
    return loadScript('binjgb.js').then(function () {
      // Modern glue: Binjgb() returns a Promise that resolves to the Module.
      // The resolve value may itself be treated as a thenable by the Promise
      // machinery, so hand it back through the same plain box for safety.
      return global.Binjgb().then(function (readyModule) {
        return boxModule(readyModule, 'wasm');
      });
    });
  }

  function loadAsmJsModule() {
    return loadScript('binjgb_asm.js').then(function () {
      // The asm.js build returns the Module synchronously from the factory.
      var Module;
      try {
        Module = global.Binjgb({
          locateFile: function (path) { return path; }
        });
      } catch (err) {
        return Promise.reject(new Error(err && err.message ? err.message : String(err)));
      }
      return settleAsmJsModule(Module, 'asmjs');
    });
  }

  var cached = null;

  function loadBinjgb() {
    if (cached) return cached;

    var engine = hasWebAssembly() ? 'wasm' : 'asmjs';
    console.log('[binjgb] using ' + engine + ' build (WebAssembly support: ' + !!hasWebAssembly() + ')');

    cached = (engine === 'wasm' ? loadWasmModule() : loadAsmJsModule())
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
