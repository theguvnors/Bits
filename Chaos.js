(function () {
  if (window.__BrowserChaosMonkey__) {
    console.warn("Browser Chaos Monkey already injected as window.__BrowserChaosMonkey__");
    if (window.__BrowserChaosMonkey__.showPanel) {
      window.__BrowserChaosMonkey__.showPanel();
    }
    return;
  }

  var Chaos = {
    config: {
      idb: {
        enabled: true,
        maxDelayMs: 300,
        errorProbability: 10,      // %
        corruptReadProbability: 10 // %
      },
      network: {
        enabled: false,
        maxDelayMs: 500,
        errorProbability: 5,       // %
        dropProbability: 5,        // %
        corruptJsonProbability: 10 // %
      },
      offlineFlap: {
        enabled: false,
        minIntervalMs: 3000,
        maxIntervalMs: 8000
      },
      cpu: {
        enabled: false,
        spikeIntervalMs: 10000,
        maxSpikeMs: 800
      },
      scroll: {
        enabled: false,
        intervalMs: 5000
      },
      resizeStorm: {
        enabled: false,
        intervalMs: 3000
      }
    },
    state: {
      mode: "initialising",
      log: [],
      maxLog: 40,
      offlineOverride: null,
      offlineTimer: null,
      cpuTimer: null,
      scrollTimer: null,
      resizeTimer: null,
      fetchPatched: false,
      idbDexiePatched: false,
      idbRawPatched: false,
      localStoragePatched: false
    },
    ui: {
      panel: null,
      logEl: null,
      modeEl: null
    }
  };

  function logEvent(msg) {
    Chaos.state.log.push({ time: new Date().toLocaleTimeString(), msg: msg });
    if (Chaos.state.log.length > Chaos.state.maxLog) {
      Chaos.state.log.shift();
    }
    if (Chaos.ui.logEl) {
      Chaos.ui.logEl.textContent = Chaos.state.log
        .slice()
        .reverse()
        .map(function (e) { return "[" + e.time + "] " + e.msg; })
        .join("\n");
    }
  }

  function randDelay(maxMs) {
    maxMs = Number(maxMs) || 0;
    if (maxMs <= 0) return 0;
    return Math.random() * maxMs;
  }

  function randChance(percent) {
    percent = Number(percent) || 0;
    if (percent <= 0) return false;
    if (percent >= 100) return true;
    return Math.random() < percent / 100;
  }

  function corruptValue(value) {
    if (value == null) return value;

    if (Array.isArray(value)) {
      if (value.length === 0) return value;
      var filtered = value.filter(function () {
        return Math.random() > 0.5;
      });
      logEvent("Corrupted array (size " + value.length + " → " + filtered.length + ")");
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
      logEvent("Corrupted object (dropped field '" + keys[dropIndex] + "')");
      return clone;
    }

    if (Math.random() < 0.5) {
      logEvent("Corrupted primitive (" + value + " → null)");
      return null;
    }
    return value;
  }

  // ---------- IndexedDB / Dexie chaos ----------

  function wrapPromiseWithIdbChaos(type, promise, methodName) {
    var cfg = Chaos.config.idb;
    if (!cfg.enabled || !promise || typeof promise.then !== "function") {
      return promise;
    }
    return new Promise(function (resolve, reject) {
      promise.then(function (val) {
        var delay = randDelay(cfg.maxDelayMs);
        setTimeout(function () {
          if (randChance(cfg.errorProbability)) {
            var msg = "Chaos: IDB simulated error in " + type + " (" + (methodName || "unknown") + ")";
            logEvent(msg);
            reject(new Error(msg));
            return;
          }
          if (type === "read" && randChance(cfg.corruptReadProbability)) {
            val = corruptValue(val);
          }
          resolve(val);
        }, delay);
      }).catch(function (err) {
        var delay = randDelay(cfg.maxDelayMs);
        setTimeout(function () {
          reject(err);
        }, delay);
      });
    });
  }

  function wrapRequestWithIdbChaos(type, request, methodName) {
    if (!request) return request;

    var cfg = Chaos.config.idb;
    var originalSuccess = request.onsuccess;

    request.onsuccess = function (event) {
      var target = event && event.target ? event.target : request;
      var delay = randDelay(cfg.maxDelayMs);

      function proceed() {
        if (cfg.enabled && randChance(cfg.errorProbability)) {
          var msg = "Chaos: IDB simulated error in " + type + " (" + (methodName || "unknown") + ")";
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

        if (cfg.enabled && type === "read" && randChance(cfg.corruptReadProbability)) {
          var result = target.result;
          var corrupted = corruptValue(result);
          try {
            target.result = corrupted;
          } catch (e) {}
        }

        if (typeof originalSuccess === "function") {
          originalSuccess.call(request, event);
        }
      }

      if (delay > 0) setTimeout(proceed, delay);
      else proceed();
    };

    return request;
  }

  function enableDexieIdbChaos() {
    if (!window.Dexie || !Dexie.Table || Chaos.state.idbDexiePatched) return false;

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
        var res = original.apply(this, arguments);
        return wrapPromiseWithIdbChaos(methodTypes[name], res, "Dexie.Table." + name);
      };
      tProto[name].__chaosPatched = true;
    });

    Chaos.state.idbDexiePatched = true;
    Chaos.state.mode = "Dexie.Table patched";
    logEvent("Dexie detected; IDB chaos applied.");
    return true;
  }

  function enableRawIdbChaos() {
    if (!("IDBObjectStore" in window) || Chaos.state.idbRawPatched) return false;

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
        var req = original.apply(this, arguments);
        return wrapRequestWithIdbChaos(m.type, req, "IDBObjectStore." + m.name);
      };
      proto[m.name].__chaosPatched = true;
    });

    Chaos.state.idbRawPatched = true;
    Chaos.state.mode = "IDBObjectStore patched";
    logEvent("Raw IndexedDB objectStore methods wrapped with chaos.");
    return true;
  }

  function autoHookIdb() {
    var ok = false;
    if (enableDexieIdbChaos()) ok = true;
    else if (enableRawIdbChaos()) ok = true;

    if (!ok) {
      Chaos.state.mode = "No Dexie/IDBObjectStore to hook yet";
      logEvent("No Dexie/IDBObjectStore available to hook right now.");
    }
  }

  // ---------- Network chaos (fetch) ----------

  (function patchFetchOnce() {
    if (!window.fetch || Chaos.state.fetchPatched) return;
    var originalFetch = window.fetch;

    window.fetch = function () {
      var args = arguments;
      var cfg = Chaos.config.network;

      if (!cfg.enabled) {
        return originalFetch.apply(this, args);
      }

      var self = this;
      return new Promise(function (resolve, reject) {
        originalFetch.apply(self, args)
          .then(function (resp) {
            var delay = randDelay(cfg.maxDelayMs);
            setTimeout(function () {
              if (randChance(cfg.dropProbability)) {
                logEvent("Network: dropped fetch request");
                reject(new Error("Chaos: dropped fetch request"));
                return;
              }

              if (randChance(cfg.errorProbability)) {
                logEvent("Network: injected 500 response");
                resolve(new Response("Chaos error", {
                  status: 500,
                  statusText: "ChaosInjected"
                }));
                return;
              }

              if (randChance(cfg.corruptJsonProbability)) {
                var origJson = resp.json.bind(resp);
                resp.json = function () {
                  return origJson().then(function (data) {
                    logEvent("Network: corrupting JSON body");
                    return corruptValue(data);
                  });
                };
              }

              resolve(resp);
            }, delay);
          })
          .catch(function (err) {
            var delay2 = randDelay(cfg.maxDelayMs);
            setTimeout(function () {
              reject(err);
            }, delay2);
          });
      });
    };

    Chaos.state.fetchPatched = true;
    logEvent("Network: fetch() wrapped for chaos.");
  })();

  // ---------- Offline flapping ----------

  (function patchNavigatorOnLine() {
    try {
      var getter = function () {
        if (Chaos.state.offlineOverride === null) {
          return navigator.__realOnLine__ != null ? navigator.__realOnLine__ : navigator.__proto__.onLine;
        }
        return !Chaos.state.offlineOverride ? true : false;
      };

      if (navigator.__realOnLine__ == null) {
        navigator.__realOnLine__ = navigator.onLine;
      }

      Object.defineProperty(Navigator.prototype, "onLine", {
        configurable: true,
        get: getter
      });

      logEvent("Patched navigator.onLine getter for offline chaos.");
    } catch (e) {
      logEvent("Could not patch navigator.onLine: " + e.message);
    }
  })();

  function scheduleNextOfflineFlip() {
    var cfg = Chaos.config.offlineFlap;
    if (!cfg.enabled) return;

    var interval = cfg.minIntervalMs +
      Math.random() * (cfg.maxIntervalMs - cfg.minIntervalMs);

    Chaos.state.offlineTimer = setTimeout(function () {
      if (!cfg.enabled) return;
      Chaos.state.offlineOverride = !Chaos.state.offlineOverride;
      var offline = !!Chaos.state.offlineOverride;

      var evtName = offline ? "offline" : "online";
      logEvent("Offline flap: firing '" + evtName + "' event; onLine=" + (!offline));

      window.dispatchEvent(new Event(evtName));
      scheduleNextOfflineFlip();
    }, interval);
  }

  function startOfflineFlap() {
    stopOfflineFlap();
    Chaos.state.offlineOverride = navigator.onLine === false;
    scheduleNextOfflineFlip();
  }

  function stopOfflineFlap() {
    if (Chaos.state.offlineTimer) {
      clearTimeout(Chaos.state.offlineTimer);
      Chaos.state.offlineTimer = null;
    }
    Chaos.state.offlineOverride = null;
  }

  // ---------- CPU chaos ----------

  function cpuSpikeOnce() {
    var cfg = Chaos.config.cpu;
    if (!cfg.enabled) return;

    var maxMs = Number(cfg.maxSpikeMs) || 0;
    if (maxMs <= 0) return;

    var duration = Math.random() * maxMs;
    var start = performance.now();
    logEvent("CPU spike: busy loop for ~" + Math.round(duration) + " ms");

    while (performance.now() - start < duration) {
      // busy loop
    }
  }

  function startCpuChaos() {
    stopCpuChaos();
    var cfg = Chaos.config.cpu;
    Chaos.state.cpuTimer = setInterval(function () {
      if (!cfg.enabled) return;
      cpuSpikeOnce();
    }, cfg.spikeIntervalMs || 10000);
  }

  function stopCpuChaos() {
    if (Chaos.state.cpuTimer) {
      clearInterval(Chaos.state.cpuTimer);
      Chaos.state.cpuTimer = null;
    }
  }

  // ---------- Scroll chaos ----------

  function scrollChaosTick() {
    var cfg = Chaos.config.scroll;
    if (!cfg.enabled) return;
    if (!document.body) return;

    var max = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    var target = Math.random() * max;
    logEvent("Scroll chaos: jumping to Y=" + Math.round(target));
    try {
      window.scrollTo({ top: target, behavior: "smooth" });
    } catch (e) {
      window.scrollTo(0, target);
    }
  }

  function startScrollChaos() {
    stopScrollChaos();
    var cfg = Chaos.config.scroll;
    Chaos.state.scrollTimer = setInterval(scrollChaosTick, cfg.intervalMs || 5000);
  }

  function stopScrollChaos() {
    if (Chaos.state.scrollTimer) {
      clearInterval(Chaos.state.scrollTimer);
      Chaos.state.scrollTimer = null;
    }
  }

  // ---------- Resize storm ----------

  function resizeChaosTick() {
    var cfg = Chaos.config.resizeStorm;
    if (!cfg.enabled) return;
    logEvent("Resize storm: dispatching resize event");
    window.dispatchEvent(new Event("resize"));
  }

  function startResizeChaos() {
    stopResizeChaos();
    var cfg = Chaos.config.resizeStorm;
    Chaos.state.resizeTimer = setInterval(resizeChaosTick, cfg.intervalMs || 3000);
  }

  function stopResizeChaos() {
    if (Chaos.state.resizeTimer) {
      clearInterval(Chaos.state.resizeTimer);
      Chaos.state.resizeTimer = null;
    }
  }

  // ---------- LocalStorage chaos (lightweight) ----------

  (function patchLocalStorage() {
    try {
      if (!window.localStorage || Chaos.state.localStoragePatched) return;
      var ls = window.localStorage;
      var origGet = ls.getItem.bind(ls);
      var origSet = ls.setItem.bind(ls);

      ls.getItem = function (key) {
        var val = origGet(key);
        // read corruption piggybacks IDB config for simplicity
        if (Chaos.config.idb.enabled && randChance(Chaos.config.idb.corruptReadProbability)) {
          try {
            var parsed = JSON.parse(val);
            var corrupted = corruptValue(parsed);
            return JSON.stringify(corrupted);
          } catch (e) {
            if (randChance(50)) {
              logEvent("LocalStorage: returning null instead of value for '" + key + "'");
              return null;
            }
          }
        }
        return val;
      };

      ls.setItem = function (key, value) {
        if (Chaos.config.idb.enabled && randChance(Chaos.config.idb.errorProbability)) {
          logEvent("LocalStorage: simulating write failure for '" + key + "'");
          throw new Error("Chaos: LocalStorage write blocked");
        }
        return origSet(key, value);
      };

      Chaos.state.localStoragePatched = true;
      logEvent("LocalStorage: getItem/setItem wrapped for chaos.");
    } catch (e) {
      logEvent("LocalStorage chaos unavailable: " + e.message);
    }
  })();

  // ---------- UI panel ----------

  function createLabeledRow(labelText, inputEl) {
    var row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.margin = "2px 0";

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

  function makeCheckbox(initial, onChange) {
    var el = document.createElement("input");
    el.type = "checkbox";
    el.checked = !!initial;
    el.onchange = function () {
      onChange(el.checked);
    };
    return el;
  }

  function makeNumberInput(initial, min, max, onChange, widthPx) {
    var el = document.createElement("input");
    el.type = "number";
    if (min != null) el.min = String(min);
    if (max != null) el.max = String(max);
    el.value = String(initial);
    el.style.width = (widthPx || 70) + "px";
    el.onchange = function () {
      var v = parseFloat(el.value);
      if (isNaN(v)) v = initial;
      if (min != null && v < min) v = min;
      if (max != null && v > max) v = max;
      el.value = String(v);
      onChange(v);
    };
    return el;
  }

  function createPanel() {
    if (!document.body) return;

    var panel = document.createElement("div");
    panel.style.position = "fixed";
    panel.style.top = "16px";
    panel.style.right = "16px";
    panel.style.width = "290px";
    panel.style.zIndex = "999999";
    panel.style.fontFamily = "system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    panel.style.fontSize = "12px";

    var shadow = panel.attachShadow ? panel.attachShadow({ mode: "open" }) : panel;
    var container = document.createElement("div");
    container.style.background = "rgba(0,0,0,0.94)";
    container.style.color = "#eee";
    container.style.borderRadius = "6px";
    container.style.padding = "8px 10px";
    container.style.boxShadow = "0 4px 14px rgba(0,0,0,0.7)";
    container.style.border = "1px solid rgba(255,255,255,0.12)";
    container.style.boxSizing = "border-box";
    container.style.maxHeight = "80vh";
    container.style.overflow = "auto";

    var header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.marginBottom = "6px";
    header.style.cursor = "move";

    var title = document.createElement("div");
    title.textContent = "Browser Chaos Monkey";
    title.style.fontWeight = "600";
    title.style.fontSize = "13px";

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

    header.appendChild(title);
    header.appendChild(closeBtn);

    (function makeDraggable() {
      var isDown = false;
      var offsetX = 0;
      var offsetY = 0;

      header.addEventListener("mousedown", function (e) {
        isDown = true;
        var rect = panel.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        panel.style.right = "auto";
        e.preventDefault();
      });
      window.addEventListener("mousemove", function (e) {
        if (!isDown) return;
        panel.style.left = e.clientX - offsetX + "px";
        panel.style.top = e.clientY - offsetY + "px";
      });
      window.addEventListener("mouseup", function () {
        isDown = false;
      });
    })();

    var modeEl = document.createElement("div");
    modeEl.style.fontSize = "11px";
    modeEl.style.opacity = "0.75";
    modeEl.style.marginBottom = "4px";
    modeEl.textContent = "Mode: " + Chaos.state.mode;
    Chaos.ui.modeEl = modeEl;

    function sectionTitle(text) {
      var el = document.createElement("div");
      el.textContent = text;
      el.style.marginTop = "6px";
      el.style.marginBottom = "2px";
      el.style.fontWeight = "600";
      el.style.fontSize = "11px";
      el.style.textTransform = "uppercase";
      el.style.color = "#ddd";
      el.style.borderTop = "1px solid rgba(255,255,255,0.12)";
      el.style.paddingTop = "4px";
      return el;
    }

    // --- IDB section ---
    var idbCheckbox = makeCheckbox(Chaos.config.idb.enabled, function (checked) {
      Chaos.config.idb.enabled = checked;
      logEvent("IDB chaos " + (checked ? "ENABLED" : "disabled"));
    });
    var idbEnabledRow = createLabeledRow("IndexedDB chaos", idbCheckbox);

    var idbDelayInput = makeNumberInput(Chaos.config.idb.maxDelayMs, 0, 5000, function (v) {
      Chaos.config.idb.maxDelayMs = v;
    });
    var idbDelayRow = createLabeledRow("IDB max delay (ms)", idbDelayInput);

    var idbErrInput = makeNumberInput(Chaos.config.idb.errorProbability, 0, 100, function (v) {
      Chaos.config.idb.errorProbability = v;
    }, 60);
    var idbErrRow = createLabeledRow("IDB error (%)", idbErrInput);

    var idbCorInput = makeNumberInput(Chaos.config.idb.corruptReadProbability, 0, 100, function (v) {
      Chaos.config.idb.corruptReadProbability = v;
    }, 60);
    var idbCorRow = createLabeledRow("IDB corrupt reads (%)", idbCorInput);

    var rehookBtn = document.createElement("button");
    rehookBtn.textContent = "Re-hook IDB";
    rehookBtn.style.fontSize = "11px";
    rehookBtn.style.padding = "2px 6px";
    rehookBtn.style.margin = "2px 0";
    rehookBtn.style.borderRadius = "4px";
    rehookBtn.style.border = "1px solid #555";
    rehookBtn.style.background = "#222";
    rehookBtn.style.color = "#eee";
    rehookBtn.style.cursor = "pointer";
    rehookBtn.onclick = function () {
      autoHookIdb();
      if (Chaos.ui.modeEl) {
        Chaos.ui.modeEl.textContent = "Mode: " + Chaos.state.mode;
      }
    };

    // --- Network section ---
    var netCheckbox = makeCheckbox(Chaos.config.network.enabled, function (checked) {
      Chaos.config.network.enabled = checked;
      logEvent("Network chaos " + (checked ? "ENABLED" : "disabled"));
    });
    var netEnabledRow = createLabeledRow("Network (fetch) chaos", netCheckbox);

    var netDelayInput = makeNumberInput(Chaos.config.network.maxDelayMs, 0, 10000, function (v) {
      Chaos.config.network.maxDelayMs = v;
    });
    var netDelayRow = createLabeledRow("Fetch max delay (ms)", netDelayInput);

    var netErrInput = makeNumberInput(Chaos.config.network.errorProbability, 0, 100, function (v) {
      Chaos.config.network.errorProbability = v;
    }, 60);
    var netErrRow = createLabeledRow("Fetch 500s (%)", netErrInput);

    var netDropInput = makeNumberInput(Chaos.config.network.dropProbability, 0, 100, function (v) {
      Chaos.config.network.dropProbability = v;
    }, 60);
    var netDropRow = createLabeledRow("Drop requests (%)", netDropInput);

    var netCorJsonInput = makeNumberInput(Chaos.config.network.corruptJsonProbability, 0, 100, function (v) {
      Chaos.config.network.corruptJsonProbability = v;
    }, 60);
    var netCorJsonRow = createLabeledRow("Corrupt JSON (%)", netCorJsonInput);

    // --- Offline section ---
    var offlineCheckbox = makeCheckbox(Chaos.config.offlineFlap.enabled, function (checked) {
      Chaos.config.offlineFlap.enabled = checked;
      logEvent("Offline flapping " + (checked ? "ENABLED" : "disabled"));
      if (checked) startOfflineFlap();
      else stopOfflineFlap();
    });
    var offlineRow = createLabeledRow("Offline/online flapping", offlineCheckbox);

    // --- CPU section ---
    var cpuCheckbox = makeCheckbox(Chaos.config.cpu.enabled, function (checked) {
      Chaos.config.cpu.enabled = checked;
      logEvent("CPU spike chaos " + (checked ? "ENABLED" : "disabled"));
      if (checked) startCpuChaos();
      else stopCpuChaos();
    });
    var cpuRow = createLabeledRow("CPU spikes", cpuCheckbox);

    var cpuIntInput = makeNumberInput(Chaos.config.cpu.spikeIntervalMs, 2000, 60000, function (v) {
      Chaos.config.cpu.spikeIntervalMs = v;
      if (Chaos.config.cpu.enabled) startCpuChaos();
    });
    var cpuIntRow = createLabeledRow("CPU spike interval (ms)", cpuIntInput);

    var cpuDurInput = makeNumberInput(Chaos.config.cpu.maxSpikeMs, 50, 3000, function (v) {
      Chaos.config.cpu.maxSpikeMs = v;
    }, 60);
    var cpuDurRow = createLabeledRow("CPU max spike (ms)", cpuDurInput);

    // --- Scroll chaos ---
    var scrollCheckbox = makeCheckbox(Chaos.config.scroll.enabled, function (checked) {
      Chaos.config.scroll.enabled = checked;
      logEvent("Scroll chaos " + (checked ? "ENABLED" : "disabled"));
      if (checked) startScrollChaos();
      else stopScrollChaos();
    });
    var scrollRow = createLabeledRow("Random scroll jumps", scrollCheckbox);

    // --- Resize storm ---
    var resizeCheckbox = makeCheckbox(Chaos.config.resizeStorm.enabled, function (checked) {
      Chaos.config.resizeStorm.enabled = checked;
      logEvent("Resize storm " + (checked ? "ENABLED" : "disabled"));
      if (checked) startResizeChaos();
      else stopResizeChaos();
    });
    var resizeRow = createLabeledRow("Resize event storm", resizeCheckbox);

    // Log area
    var logLabel = document.createElement("div");
    logLabel.textContent = "Recent events:";
    logLabel.style.marginTop = "4px";
    logLabel.style.fontSize = "11px";
    logLabel.style.opacity = "0.8";

    var logBox = document.createElement("pre");
    logBox.style.margin = "2px 0 0 0";
    logBox.style.maxHeight = "140px";
    logBox.style.overflow = "auto";
    logBox.style.background = "rgba(255,255,255,0.03)";
    logBox.style.padding = "4px";
    logBox.style.borderRadius = "3px";
    logBox.style.border = "1px solid rgba(255,255,255,0.08)";
    logBox.style.fontSize = "10px";
    logBox.style.whiteSpace = "pre-wrap";
    Chaos.ui.logEl = logBox;

    var clearLogBtn = document.createElement("button");
    clearLogBtn.textContent = "Clear log";
    clearLogBtn.style.fontSize = "11px";
    clearLogBtn.style.padding = "2px 6px";
    clearLogBtn.style.marginTop = "3px";
    clearLogBtn.style.borderRadius = "4px";
    clearLogBtn.style.border = "1px solid #555";
    clearLogBtn.style.background = "#222";
    clearLogBtn.style.color = "#eee";
    clearLogBtn.style.cursor = "pointer";
    clearLogBtn.onclick = function () {
      Chaos.state.log = [];
      logBox.textContent = "";
    };

    container.appendChild(header);
    container.appendChild(modeEl);

    container.appendChild(sectionTitle("IndexedDB & storage"));
    container.appendChild(idbEnabledRow);
    container.appendChild(idbDelayRow);
    container.appendChild(idbErrRow);
    container.appendChild(idbCorRow);
    container.appendChild(rehookBtn);

    container.appendChild(sectionTitle("Network"));
    container.appendChild(netEnabledRow);
    container.appendChild(netDelayRow);
    container.appendChild(netErrRow);
    container.appendChild(netDropRow);
    container.appendChild(netCorJsonRow);

    container.appendChild(sectionTitle("Offline & CPU"));
    container.appendChild(offlineRow);
    container.appendChild(cpuRow);
    container.appendChild(cpuIntRow);
    container.appendChild(cpuDurRow);

    container.appendChild(sectionTitle("UI events"));
    container.appendChild(scrollRow);
    container.appendChild(resizeRow);

    container.appendChild(logLabel);
    container.appendChild(logBox);
    container.appendChild(clearLogBtn);

    shadow.appendChild(container);
    document.body.appendChild(panel);

    Chaos.ui.panel = panel;
  }

  // Expose for tweaking from console
  Chaos.showPanel = function () {
    if (!Chaos.ui.panel || !document.body.contains(Chaos.ui.panel)) {
      createPanel();
    }
  };

  window.__BrowserChaosMonkey__ = Chaos;

  autoHookIdb();
  Chaos.showPanel();
  logEvent("Browser Chaos Monkey injected. Access via window.__BrowserChaosMonkey__.");
})();
