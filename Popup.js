(function () {
  if (window.__IndexedDbChaos__) {
    console.warn("IndexedDB Chaos already installed as window.__IndexedDbChaos__");
    return;
  }

  var ChaosEngine = {
    config: {
      enabled: true,
      maxDelayMs: 300,
      errorProbability: 10,      // %
      corruptReadProbability: 10 // %
    },
    mode: "none",
    log: [],
    maxLog: 20
  };

  function logEvent(msg) {
    ChaosEngine.log.push({ time: new Date().toLocaleTimeString(), msg: msg });
    if (ChaosEngine.log.length > ChaosEngine.maxLog) {
      ChaosEngine.log.shift();
    }
    if (ChaosEngine._logEl) {
      ChaosEngine._logEl.textContent = ChaosEngine.log
        .slice()
        .reverse()
        .map(function (e) { return "[" + e.time + "] " + e.msg; })
        .join("\n");
    }
  }

  function getRandomDelay() {
    if (!ChaosEngine.config.enabled) return 0;
    var max = Number(ChaosEngine.config.maxDelayMs) || 0;
    if (max <= 0) return 0;
    return Math.random() * max;
  }

  function shouldError() {
    if (!ChaosEngine.config.enabled) return false;
    var p = Number(ChaosEngine.config.errorProbability) || 0;
    return Math.random() < p / 100;
  }

  function shouldCorruptRead() {
    if (!ChaosEngine.config.enabled) return false;
    var p = Number(ChaosEngine.config.corruptReadProbability) || 0;
    return Math.random() < p / 100;
  }

  function corruptValue(value) {
    if (value == null) return value;

    if (Array.isArray(value)) {
      if (value.length === 0) return value;
      // Randomly drop some elements
      var filtered = value.filter(function () {
        return Math.random() > 0.5;
      });
      logEvent("Corrupted array read (size " + value.length + " → " + filtered.length + ")");
      return filtered;
    }

    if (typeof value === "object") {
      var clone = {};
      var keys = Object.keys(value);
      if (keys.length === 0) return value;
      var dropIndex = Math.floor(Math.random() * keys.length);
      for (var i = 0; i < keys.length; i++) {
        if (i === dropIndex) continue;
        clone[keys[i]] = value[keys[i]];
      }
      logEvent("Corrupted object read (dropped field '" + keys[dropIndex] + "')");
      return clone;
    }

    // For primitives, sometimes null them out
    if (Math.random() < 0.5) {
      logEvent("Corrupted primitive read (" + value + " → null)");
      return null;
    }
    return value;
  }

  ChaosEngine.wrapPromise = function (type, promise, methodName) {
    if (!ChaosEngine.config.enabled || !promise || typeof promise.then !== "function") {
      return promise;
    }
    return new Promise(function (resolve, reject) {
      promise.then(function (val) {
        var delay = getRandomDelay();
        setTimeout(function () {
          if (shouldError()) {
            var msg = "ChaosEngine: simulated error in " + type + " (" + (methodName || "unknown") + ")";
            logEvent(msg);
            reject(new Error(msg));
            return;
          }
          if (type === "read" && shouldCorruptRead()) {
            val = corruptValue(val);
          }
          resolve(val);
        }, delay);
      }).catch(function (err) {
        var delay = getRandomDelay();
        setTimeout(function () {
          reject(err);
        }, delay);
      });
    });
  };

  ChaosEngine.wrapRequest = function (type, request, methodName) {
    if (!request) return request;
    if (!ChaosEngine.config.enabled) return request;

    var originalSuccess = request.onsuccess;
    request.onsuccess = function (event) {
      var delay = getRandomDelay();
      var target = event && event.target ? event.target : request;

      function proceed() {
        if (shouldError()) {
          var msg = "ChaosEngine: simulated IDB error in " + type + " (" + (methodName || "unknown") + ")";
          logEvent(msg);
          if (typeof request.onerror === "function") {
            try {
              Object.defineProperty(request, "error", {
                value: new Error(msg),
                configurable: true
              });
            } catch (e) {
              request.error = new Error(msg);
            }
            request.onerror({ target: request, type: "error" });
          } else {
            console.error(msg);
          }
          return;
        }

        var result = target.result;
        if (type === "read" && shouldCorruptRead()) {
          var corrupted = corruptValue(result);
          try {
            target.result = corrupted;
          } catch (e) {
            // result is often read-only, so just live with original
          }
        }

        if (typeof originalSuccess === "function") {
          originalSuccess.call(request, event);
        }
      }

      if (delay > 0) {
        setTimeout(proceed, delay);
      } else {
        proceed();
      }
    };

    return request;
  };

  ChaosEngine.enableDexie = function () {
    if (!window.Dexie || !Dexie.Table || ChaosEngine._dexiePatched) return false;

    var tProto = Dexie.Table.prototype;
    var methodTypes = {
      get: "read",
      getAll: "read",
      toArray: "read",
      count: "read",
      add: "write",
      put: "write",
      update: "write",
      delete: "write",
      bulkAdd: "write",
      bulkPut: "write",
      bulkDelete: "write",
      clear: "write"
    };

    Object.keys(methodTypes).forEach(function (name) {
      var original = tProto[name];
      if (!original || original.__chaosPatched) return;

      tProto[name] = function () {
        var result = original.apply(this, arguments);
        return ChaosEngine.wrapPromise(methodTypes[name], result, "Dexie.Table." + name);
      };
      tProto[name].__chaosPatched = true;
    });

    ChaosEngine._dexiePatched = true;
    ChaosEngine.mode = "Dexie.Table prototype patched";
    logEvent("Dexie detected; Table methods wrapped with chaos.");
    return true;
  };

  ChaosEngine.enableRawIndexedDB = function () {
    if (!("IDBObjectStore" in window) || ChaosEngine._rawPatched) return false;

    var proto = IDBObjectStore.prototype;
    var methods = [
      { name: "get", type: "read" },
      { name: "getAll", type: "read" },
      { name: "add", type: "write" },
      { name: "put", type: "write" },
      { name: "delete", type: "write" },
      { name: "clear", type: "write" }
    ];

    methods.forEach(function (m) {
      var original = proto[m.name];
      if (!original || original.__chaosPatched) return;

      proto[m.name] = function () {
        var request = original.apply(this, arguments);
        return ChaosEngine.wrapRequest(m.type, request, "IDBObjectStore." + m.name);
      };
      proto[m.name].__chaosPatched = true;
    });

    ChaosEngine._rawPatched = true;
    ChaosEngine.mode = "IDBObjectStore prototype patched";
    logEvent("Raw IndexedDB objectStore methods wrapped with chaos.");
    return true;
  };

  ChaosEngine.autoHook = function () {
    var ok = false;
    if (ChaosEngine.enableDexie()) {
      ok = true;
    } else if (ChaosEngine.enableRawIndexedDB()) {
      ok = true;
    }
    if (!ok) {
      ChaosEngine.mode = "no Dexie / IDBObjectStore available (yet)";
      logEvent("No Dexie or IndexedDB objectStore to hook right now.");
    }
  };

  // UI creation
  function createUI() {
    var panel = document.createElement("div");
    panel.style.position = "fixed";
    panel.style.top = "12px";
    panel.style.right = "12px";
    panel.style.width = "260px";
    panel.style.zIndex = "999999";
    panel.style.fontFamily = "system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    panel.style.fontSize = "12px";

    // Shadow root to avoid CSS interference
    var shadow = panel.attachShadow ? panel.attachShadow({ mode: "open" }) : panel;
    var container = document.createElement("div");
    container.style.background = "rgba(0,0,0,0.9)";
    container.style.color = "#eee";
    container.style.borderRadius = "6px";
    container.style.padding = "8px 10px 8px 10px";
    container.style.boxShadow = "0 4px 12px rgba(0,0,0,0.6)";
    container.style.border = "1px solid rgba(255,255,255,0.12)";
    container.style.boxSizing = "border-box";
    container.style.cursor = "default";

    var header = document.createElement("div");
    header.textContent = "IndexedDB Chaos Engine";
    header.style.fontWeight = "600";
    header.style.marginBottom = "6px";
    header.style.fontSize = "13px";
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.cursor = "move";

    var closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.background = "transparent";
    closeBtn.style.border = "none";
    closeBtn.style.color = "#eee";
    closeBtn.style.fontSize = "14px";
    closeBtn.style.cursor = "pointer";
    closeBtn.onclick = function (e) {
      e.stopPropagation();
      panel.remove();
    };
    header.appendChild(closeBtn);

    // Dragging
    (function () {
      var isDown = false;
      var offsetX = 0;
      var offsetY = 0;

      header.addEventListener("mousedown", function (e) {
        isDown = true;
        offsetX = e.clientX - panel.getBoundingClientRect().left;
        offsetY = e.clientY - panel.getBoundingClientRect().top;
        e.preventDefault();
      });
      window.addEventListener("mousemove", function (e) {
        if (!isDown) return;
        panel.style.left = e.clientX - offsetX + "px";
        panel.style.top = e.clientY - offsetY + "px";
        panel.style.right = "auto";
      });
      window.addEventListener("mouseup", function () {
        isDown = false;
      });
    })();

    var modeEl = document.createElement("div");
    modeEl.style.fontSize = "11px";
    modeEl.style.opacity = "0.7";
    modeEl.style.marginBottom = "4px";
    modeEl.textContent = "Mode: " + ChaosEngine.mode;

    // Controls
    function makeRow(labelText, inputEl) {
      var row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.margin = "3px 0";

      var label = document.createElement("label");
      label.textContent = labelText;
      label.style.flex = "1";
      label.style.marginRight = "6px";

      inputEl.style.flex = "0 0 auto";
      inputEl.style.fontSize = "11px";

      row.appendChild(label);
      row.appendChild(inputEl);
      return row;
    }

    // Enabled checkbox
    var enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = ChaosEngine.config.enabled;
    enabledInput.onchange = function () {
      ChaosEngine.config.enabled = enabledInput.checked;
      logEvent("Chaos " + (enabledInput.checked ? "ENABLED" : "disabled") + " via UI.");
    };

    var enabledRow = makeRow("Enabled", enabledInput);

    // Max delay
    var delayInput = document.createElement("input");
    delayInput.type = "number";
    delayInput.min = "0";
    delayInput.max = "5000";
    delayInput.value = String(ChaosEngine.config.maxDelayMs);
    delayInput.style.width = "70px";
    delayInput.onchange = function () {
      var v = parseInt(delayInput.value, 10);
      if (isNaN(v) || v < 0) v = 0;
      ChaosEngine.config.maxDelayMs = v;
      delayInput.value = String(v);
    };
    var delayRow = makeRow("Max delay (ms)", delayInput);

    // Error probability
    var errInput = document.createElement("input");
    errInput.type = "number";
    errInput.min = "0";
    errInput.max = "100";
    errInput.value = String(ChaosEngine.config.errorProbability);
    errInput.style.width = "60px";
    errInput.onchange = function () {
      var v = parseFloat(errInput.value);
      if (isNaN(v) || v < 0) v = 0;
      if (v > 100) v = 100;
      ChaosEngine.config.errorProbability = v;
      errInput.value = String(v);
    };
    var errRow = makeRow("Error probability (%)", errInput);

    // Corrupt probability
    var corruptInput = document.createElement("input");
    corruptInput.type = "number";
    corruptInput.min = "0";
    corruptInput.max = "100";
    corruptInput.value = String(ChaosEngine.config.corruptReadProbability);
    corruptInput.style.width = "60px";
    corruptInput.onchange = function () {
      var v = parseFloat(corruptInput.value);
      if (isNaN(v) || v < 0) v = 0;
      if (v > 100) v = 100;
      ChaosEngine.config.corruptReadProbability = v;
      corruptInput.value = String(v);
    };
    var corruptRow = makeRow("Corrupt reads (%)", corruptInput);

    // Buttons
    var btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.justifyContent = "space-between";
    btnRow.style.margin = "4px 0 4px 0";

    var rehookBtn = document.createElement("button");
    rehookBtn.textContent = "Re-hook";
    rehookBtn.style.fontSize = "11px";
    rehookBtn.style.padding = "2px 6px";
    rehookBtn.style.borderRadius = "4px";
    rehookBtn.style.border = "1px solid #555";
    rehookBtn.style.background = "#222";
    rehookBtn.style.color = "#eee";
    rehookBtn.style.cursor = "pointer";
    rehookBtn.onclick = function () {
      ChaosEngine.autoHook();
      modeEl.textContent = "Mode: " + ChaosEngine.mode;
    };

    var clearLogBtn = document.createElement("button");
    clearLogBtn.textContent = "Clear log";
    clearLogBtn.style.fontSize = "11px";
    clearLogBtn.style.padding = "2px 6px";
    clearLogBtn.style.borderRadius = "4px";
    clearLogBtn.style.border = "1px solid #555";
    clearLogBtn.style.background = "#222";
    clearLogBtn.style.color = "#eee";
    clearLogBtn.style.cursor = "pointer";
    clearLogBtn.onclick = function () {
      ChaosEngine.log = [];
      ChaosEngine._logEl.textContent = "";
    };

    btnRow.appendChild(rehookBtn);
    btnRow.appendChild(clearLogBtn);

    // Log area
    var logLabel = document.createElement("div");
    logLabel.textContent = "Recent events:";
    logLabel.style.marginTop = "4px";
    logLabel.style.fontSize = "11px";
    logLabel.style.opacity = "0.8";

    var logBox = document.createElement("pre");
    logBox.style.margin = "2px 0 0 0";
    logBox.style.maxHeight = "120px";
    logBox.style.overflow = "auto";
    logBox.style.background = "rgba(255,255,255,0.03)";
    logBox.style.padding = "4px";
    logBox.style.borderRadius = "3px";
    logBox.style.border = "1px solid rgba(255,255,255,0.08)";
    logBox.style.fontSize = "10px";
    logBox.style.whiteSpace = "pre-wrap";

    ChaosEngine._logEl = logBox;

    container.appendChild(header);
    container.appendChild(modeEl);
    container.appendChild(enabledRow);
    container.appendChild(delayRow);
    container.appendChild(errRow);
    container.appendChild(corruptRow);
    container.appendChild(btnRow);
    container.appendChild(logLabel);
    container.appendChild(logBox);

    shadow.appendChild(container);
    document.body.appendChild(panel);

    // Update mode text initially
    modeEl.textContent = "Mode: " + ChaosEngine.mode;
  }

  // Expose globally so you can tweak from console if you want
  window.__IndexedDbChaos__ = ChaosEngine;

  ChaosEngine.autoHook();
  createUI();
  logEvent("IndexedDB Chaos Engine injected. Config via window.__IndexedDbChaos__");
})();
