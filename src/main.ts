import "./style.css";
import {
  SoloSerialDevice,
  BAUD_COMMAND,
  BAUD_DATA,
  type ArgDef,
  type CommandEntry,
  type ConsoleEntry,
  type DeviceInfo,
  type DeviceState,
} from "./solo-serial";

// ─── WebSerial support check ───────────────────────────────────────────────────

const device = new SoloSerialDevice();
let currentInfo: DeviceInfo | null  = null;
let currentState: DeviceState | null = null;

if (!("serial" in navigator)) {
  (document.getElementById("no-webserial") as HTMLElement).hidden = false;
  (document.getElementById("connect-btn") as HTMLButtonElement).disabled = true;
}

// ─── DOM refs ──────────────────────────────────────────────────────────────────

const connectBtn    = document.getElementById("connect-btn")    as HTMLButtonElement;
const disconnectBtn = document.getElementById("disconnect-btn") as HTMLButtonElement;
const statusDot     = document.getElementById("status-dot")     as HTMLElement;
const statusText    = document.getElementById("status-text")    as HTMLElement;
const infoPanel     = document.getElementById("info-panel")     as HTMLElement;
const commandsPanel = document.getElementById("commands-panel") as HTMLElement;
const consoleEl     = document.getElementById("console-output") as HTMLElement;
const consoleClear  = document.getElementById("console-clear")  as HTMLButtonElement;
const consoleDataType = document.getElementById("console-data-type") as HTMLSelectElement;
const consoleInput  = document.getElementById("console-command-input") as HTMLInputElement;
const consoleSend   = document.getElementById("console-send") as HTMLButtonElement;

// ─── Console ───────────────────────────────────────────────────────────────────

const LABEL: Record<string, string> = {
  tx:       "TX",
  ack:      "ACK",
  data:     "DATA",
  debug:    "DEBUG",
  event:    "EVENT",
  "exit-ok":  "EXIT",
  "exit-err": "EXIT",
  other:    "INFO",
};

function ts(d: Date): string {
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return d.toTimeString().slice(0, 8) + "." + ms;
}

device.onConsole((entry: ConsoleEntry) => appendConsoleLine(entry));

function appendConsoleLine(entry: ConsoleEntry) {
  const atBottom =
    consoleEl.scrollHeight - consoleEl.clientHeight <= consoleEl.scrollTop + 24;

  const row = document.createElement("div");
  row.className = `console-line cat-${entry.category}`;

  const stamp = document.createElement("span");
  stamp.className = "con-ts";
  stamp.textContent = ts(entry.timestamp);

  const lbl = document.createElement("span");
  lbl.className = "con-label";
  lbl.textContent = LABEL[entry.category] ?? entry.category.toUpperCase();

  const txt = document.createElement("span");
  txt.className = "con-text";
  txt.textContent = entry.text;

  row.append(stamp, lbl, txt);
  consoleEl.appendChild(row);

  // Trim old lines to keep memory bounded
  while (consoleEl.childElementCount > 1000) {
    consoleEl.removeChild(consoleEl.firstChild!);
  }

  if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
}

function consoleInfo(msg: string) {
  appendConsoleLine({
    direction: "rx",
    category:  "other",
    text:      `--- ${msg} ---`,
    timestamp: new Date(),
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeConnectError(err: unknown): string {
  const raw = errMsg(err);
  const lower = raw.toLowerCase();

  if (err instanceof DOMException) {
    if (err.name === "NotFoundError") {
      return "No serial device was selected.";
    }
    if (err.name === "SecurityError") {
      return "Serial access was blocked by the browser. Use HTTPS/localhost and allow access.";
    }
    if (err.name === "InvalidStateError") {
      return "The selected serial device is already open. Close other apps or tabs that use this port, then try again.";
    }
    if (err.name === "NetworkError" || err.name === "OperationError") {
      if (
        lower.includes("already open")
        || lower.includes("in use")
        || lower.includes("resource busy")
        || lower.includes("failed to open serial port")
      ) {
        return "The serial device could not be opened because it is already in use by another app or browser tab.";
      }
    }
  }

  if (
    lower.includes("already open")
    || lower.includes("in use")
    || lower.includes("resource busy")
    || lower.includes("access is denied")
    || lower.includes("failed to open serial port")
  ) {
    return "The serial device could not be opened because it is already in use by another app or browser tab.";
  }

  return `Could not open the serial device. ${raw}`;
}

function consoleError(summary: string, err: unknown) {
  appendConsoleLine({
    direction: "rx",
    category:  "exit-err",
    text:      summary,
    timestamp: new Date(),
  });
  consoleInfo(`Error: ${errMsg(err)}`);
}

function setConsoleCommandEnabled(enabled: boolean) {
  consoleInput.disabled = !enabled;
  consoleSend.disabled = !enabled;
  consoleDataType.disabled = !enabled || !isDataModeActive();
}

function isDataModeActive(): boolean {
  return currentState?.mode === "data";
}

function updateConsoleEntryUi() {
  const isDataMode = isDataModeActive();
  consoleDataType.hidden = !isDataMode;
  consoleDataType.disabled = !device.isConnected || !isDataMode;

  if (!isDataMode) {
    consoleInput.placeholder = "Type command line, e.g. ping or setLabel `hello world`";
    consoleSend.textContent = "Send";
    return;
  }

  consoleSend.textContent = "Send Data";
  const selected = consoleDataType.value;
  if (selected === "hex") {
    consoleInput.placeholder = "Hex bytes, e.g. AA FF 0D or AAFF0D";
  } else if (selected === "uint8") {
    consoleInput.placeholder = "UInt8 value (0-255)";
  } else {
    consoleInput.placeholder = "Raw UTF-8 string bytes (no newline added)";
  }
}

function updateCommandPanelModeUi() {
  const inDataMode = isDataModeActive();
  const list = commandsPanel.querySelector(".commands-list") as HTMLElement | null;
  if (list) list.classList.toggle("commands-list-disabled", inDataMode);

  let notice = commandsPanel.querySelector(".commands-mode-note") as HTMLElement | null;
  if (inDataMode) {
    if (!notice) {
      notice = document.createElement("p");
      notice.className = "commands-mode-note";
      notice.textContent = "Command mode commands are disabled while the device is in data mode.";
      commandsPanel.prepend(notice);
    }
  } else if (notice) {
    notice.remove();
  }
}

function updateModeDependentUi() {
  updateConsoleEntryUi();
  updateCommandPanelModeUi();
}

function parseHexBytes(input: string): Uint8Array {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Hex payload is empty.");

  const normalized = trimmed.replace(/,/g, " ");
  const hasWhitespace = /\s/.test(normalized);
  const tokens = hasWhitespace
    ? normalized.split(/\s+/).filter(Boolean)
    : [normalized];

  const values: number[] = [];
  for (const token of tokens) {
    const clean = token.replace(/^0x/i, "");
    if (clean.length === 0) continue;

    if (!/^[0-9a-fA-F]+$/.test(clean)) {
      throw new Error(`Invalid hex token: ${token}`);
    }

    if (!hasWhitespace && clean.length > 2) {
      if (clean.length % 2 !== 0) {
        throw new Error("Hex string must contain an even number of digits.");
      }
      for (let i = 0; i < clean.length; i += 2) {
        values.push(parseInt(clean.slice(i, i + 2), 16));
      }
      continue;
    }

    if (clean.length > 2) {
      throw new Error(`Hex token exceeds one byte: ${token}`);
    }
    values.push(parseInt(clean, 16));
  }

  if (values.length === 0) throw new Error("No hex bytes parsed.");
  return new Uint8Array(values);
}

function parseDataModePayload(input: string): Uint8Array {
  const mode = consoleDataType.value;
  const raw = input.trim();

  if (mode === "hex") {
    return parseHexBytes(raw);
  }

  if (mode === "uint8") {
    if (!/^\d+$/.test(raw)) {
      throw new Error("UInt8 payload must be an integer between 0 and 255.");
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error("UInt8 payload must be an integer between 0 and 255.");
    }
    return new Uint8Array([n]);
  }

  if (!input.length) throw new Error("String payload is empty.");
  return new TextEncoder().encode(input);
}

function parseRawCommandLine(line: string): { command: string; args: string[] } {
  const input = line.trim();
  if (!input) throw new Error("Command line is empty.");

  const tokens: string[] = [];
  let current = "";
  let inBackticks = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "`") {
      inBackticks = !inBackticks;
      continue;
    }
    if (!inBackticks && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (inBackticks) {
    throw new Error("Unterminated backtick quote in command line.");
  }
  if (current.length > 0) tokens.push(current);
  if (tokens.length === 0) throw new Error("Command line is empty.");

  const [command, ...args] = tokens;
  return { command, args };
}

async function sendConsoleCommandLine() {
  if (!device.isConnected) {
    consoleInfo("Connect a device before sending manual commands.");
    return;
  }

  const rawLine = consoleInput.value;
  if (!rawLine.trim()) return;

  setConsoleCommandEnabled(false);
  try {
    if (isDataModeActive()) {
      const bytes = parseDataModePayload(rawLine);
      await device.sendRawBytes(bytes);
      consoleInfo(`Sent ${bytes.length} byte(s) in data mode as ${consoleDataType.value}.`);
    } else {
      const { command, args } = parseRawCommandLine(rawLine);
      await device.sendCommand(command, ...args);
      
      // Sync the debug checkbox if setDebug was sent manually
      if (command === "setDebug" && args.length === 1) {
        const arg = args[0].toLowerCase();
        if (arg === "1" || arg === "true") {
          const checkbox = document.querySelector(".debug-toggle input[type=\"checkbox\"]") as HTMLInputElement | null;
          if (checkbox) {
            checkbox.checked = true;
            if (currentState) currentState.debug = true;
          }
        } else if (arg === "0" || arg === "false") {
          const checkbox = document.querySelector(".debug-toggle input[type=\"checkbox\"]") as HTMLInputElement | null;
          if (checkbox) {
            checkbox.checked = false;
            if (currentState) currentState.debug = false;
          }
        }
      }
    }
    consoleInput.value = "";
  } catch (err) {
    consoleError("Manual command failed.", err);
  } finally {
    setConsoleCommandEnabled(device.isConnected);
    updateConsoleEntryUi();
    if (device.isConnected) consoleInput.focus();
  }
}

consoleClear.addEventListener("click", () => { consoleEl.innerHTML = ""; });
consoleSend.addEventListener("click", () => {
  void sendConsoleCommandLine();
});
consoleInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    void sendConsoleCommandLine();
  }
});
consoleDataType.addEventListener("change", () => {
  updateConsoleEntryUi();
  if (device.isConnected) consoleInput.focus();
});
setConsoleCommandEnabled(false);
updateModeDependentUi();

// ─── Status indicator ──────────────────────────────────────────────────────────

function setStatus(state: "disconnected" | "connecting" | "connected", label: string) {
  statusDot.dataset.state = state;
  statusText.textContent  = label;
}

// ─── Connect / disconnect ──────────────────────────────────────────────────────

connectBtn.addEventListener("click", async () => {
  connectBtn.disabled = true;
  setStatus("connecting", "Connecting…");

  try {
    await device.connect();
    setStatus("connected", "Connected");
    connectBtn.hidden    = true;
    disconnectBtn.hidden = false;
    setConsoleCommandEnabled(true);
    updateModeDependentUi();
    await probeDevice();
  } catch (err) {
    setStatus("disconnected", "Disconnected");
    connectBtn.disabled = false;
    setConsoleCommandEnabled(false);
    appendConsoleLine({
      direction: "rx",
      category:  "other",
      text:      "Connection failed.",
      timestamp: new Date(),
    });
    consoleInfo(`Error: ${errMsg(describeConnectError(err))}`);
  }
});

disconnectBtn.addEventListener("click", async () => {
  await device.disconnect();
});

device.onDisconnect(() => {
  setStatus("disconnected", "Disconnected");
  connectBtn.disabled  = false;
  connectBtn.hidden    = false;
  disconnectBtn.hidden = true;
  setConsoleCommandEnabled(false);
  currentInfo  = null;
  currentState = null;
  infoPanel.innerHTML     = `<p class="placeholder">Connect to a device to see info.</p>`;
  commandsPanel.innerHTML = `<p class="placeholder">Connect to a device to see commands.</p>`;
  updateModeDependentUi();
  consoleInfo("Disconnected.");
});

// ─── Device probing ────────────────────────────────────────────────────────────

async function probeDevice() {
  consoleInfo("Probing device…");
  const maxAttempts  = 3;
  const retryDelayMs = 1500;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      currentInfo  = await device.probeDeviceInfo();
      currentState = await device.probeDeviceState();
      const commands = await device.probeCommandList();
      renderInfoPanel(currentInfo, currentState);
      renderCommandsPanel(commands);
      updateModeDependentUi();
      consoleInfo("Ready.");
      return;
    } catch (err) {
      if (!device.isConnected) {
        // Disconnected mid-probe; give up immediately.
        consoleError("Probe failed.", err);
        infoPanel.innerHTML     = `<p class="placeholder">Probe failed. Check the console.</p>`;
        commandsPanel.innerHTML = `<p class="placeholder">Probe failed. Check the console.</p>`;
        return;
      }
      if (attempt < maxAttempts) {
        // The device may still be restarting (e.g. Leonardo DTR reset).
        consoleInfo(`Probe attempt ${attempt} failed, retrying in ${retryDelayMs / 1000} s…`);
        await new Promise<void>(r => setTimeout(r, retryDelayMs));
      } else {
        consoleError("Probe failed.", err);
        infoPanel.innerHTML     = `<p class="placeholder">Probe failed. Check the console.</p>`;
        commandsPanel.innerHTML = `<p class="placeholder">Probe failed. Check the console.</p>`;
      }
    }
  }
}

// ─── Info panel ────────────────────────────────────────────────────────────────

function renderInfoPanel(info: DeviceInfo, state: DeviceState) {
  infoPanel.innerHTML = "";

  // ── Device info table ────────────────────────────────────────────────────────
  const table = document.createElement("table");
  table.className = "info-table";

  // Display all keys from the info object as-is, no assumptions
  for (const [key, value] of Object.entries(info)) {
    const tr  = document.createElement("tr");
    const td1 = document.createElement("td");
    td1.className   = "info-label";
    td1.textContent = key;
    const td2 = document.createElement("td");
    td2.className   = "info-value";
    td2.textContent = typeof value === "object" ? JSON.stringify(value) : String(value);
    tr.append(td1, td2);
    table.appendChild(tr);
  }

  // ── Add connection info rows ─────────────────────────────────────────────────
  const portInfo = device.portInfo;
  
  if (portInfo.vendorId !== null) {
    const vidRow = document.createElement("tr");
    const vidLabel = document.createElement("td");
    vidLabel.className = "info-label";
    vidLabel.textContent = "VID";
    const vidValue = document.createElement("td");
    vidValue.className = "info-value";
    vidValue.textContent = `0x${portInfo.vendorId.toString(16).toUpperCase().padStart(4, "0")}`;
    vidRow.append(vidLabel, vidValue);
    table.appendChild(vidRow);
  }
  
  if (portInfo.productId !== null) {
    const pidRow = document.createElement("tr");
    const pidLabel = document.createElement("td");
    pidLabel.className = "info-label";
    pidLabel.textContent = "PID";
    const pidValue = document.createElement("td");
    pidValue.className = "info-value";
    pidValue.textContent = `0x${portInfo.productId.toString(16).toUpperCase().padStart(4, "0")}`;
    pidRow.append(pidLabel, pidValue);
    table.appendChild(pidRow);
  }
  
  const baudRow = document.createElement("tr");
  const baudLabel = document.createElement("td");
  baudLabel.className = "info-label";
  baudLabel.textContent = "Baud Rate";
  const baudValue = document.createElement("td");
  baudValue.className = "info-value";
  baudValue.textContent = `${device.currentBaudRate} baud`;
  baudRow.append(baudLabel, baudValue);
  table.appendChild(baudRow);

  infoPanel.appendChild(table);

  // ── Controls ─────────────────────────────────────────────────────────────────
  const controls = document.createElement("div");
  controls.className = "info-controls";

  // Debug toggle
  const debugRow = document.createElement("div");
  debugRow.className = "ctrl-row";

  const debugLabel = document.createElement("label");
  debugLabel.className = "debug-toggle";

  const cb = document.createElement("input");
  cb.type    = "checkbox";
  cb.checked = state.debug;
  cb.addEventListener("change", async () => {
    cb.disabled = true;
    try {
      await device.setDebug(cb.checked);
      if (currentState) currentState.debug = cb.checked;
    } catch (err) {
      cb.checked = !cb.checked;           // revert on failure
      consoleError("setDebug failed.", err);
    } finally {
      cb.disabled = false;
    }
  });

  const cbText = document.createElement("span");
  cbText.textContent = "Debug output";

  debugLabel.append(cb, cbText);
  debugRow.appendChild(debugLabel);
  controls.appendChild(debugRow);

  // Mode selector (only when the device supports data mode)
  if (info.has_data_mode) {
    const modeRow = document.createElement("div");
    modeRow.className = "ctrl-row";

    const modeCtrlLabel = document.createElement("span");
    modeCtrlLabel.className   = "ctrl-label";
    modeCtrlLabel.textContent = "Mode";

    const badge = document.createElement("span");
    badge.className      = "mode-badge";
    badge.dataset.mode   = state.mode;
    badge.textContent    = state.mode === "command" ? "Command" : "Data";

    const switchBtn = document.createElement("button");
    switchBtn.className   = "btn btn-sm btn-outline";
    const updateSwitchBtn = (m: "command" | "data") => {
      switchBtn.textContent = m === "command" ? "Switch to Data Mode" : "Switch to Command Mode";
    };
    updateSwitchBtn(state.mode);

    switchBtn.addEventListener("click", async () => {
      switchBtn.disabled = true;
      const currentMode = badge.dataset.mode as "command" | "data";
      const targetMode  = currentMode === "command" ? "data" : "command";
      const newBaud     = targetMode === "command" ? BAUD_COMMAND : BAUD_DATA;
      try {
        await device.switchBaud(newBaud);

        if (targetMode === "data") {
          // Data mode cannot be confirmed via getState — commands are not
          // processed in data mode.  Per the solo-serial protocol, a compliant
          // device enters data mode as soon as the host sets the baud rate.
          badge.dataset.mode = "data";
          badge.textContent  = "Data";
          updateSwitchBtn("data");
          if (currentState) {
            currentState.mode = "data";
            renderInfoPanel(currentInfo!, currentState);
          }
          updateModeDependentUi();
          consoleInfo(`Switched to data mode (${newBaud} baud).`);
        } else {
          // Command mode: verify with getState before committing any UI change.
          // probeDeviceState will retry on baud-timing races and throw on any
          // protocol error, so the UI only updates on a confirmed switch.
          const verified = await device.probeDeviceState("command");
          currentState = verified;
          renderInfoPanel(currentInfo!, currentState);
          updateModeDependentUi();
          consoleInfo(`Switched to command mode (${newBaud} baud).`);
        }
      } catch (err) {
        consoleError("Mode switch failed.", err);
      } finally {
        switchBtn.disabled = false;
      }
    });

    modeRow.append(modeCtrlLabel, badge, switchBtn);
    controls.appendChild(modeRow);
  }

  infoPanel.appendChild(controls);
}

// ─── Commands panel ────────────────────────────────────────────────────────────

function renderCommandsPanel(commands: CommandEntry[]) {
  commandsPanel.innerHTML = "";
  if (commands.length === 0) {
    commandsPanel.innerHTML = `<p class="placeholder">No commands found.</p>`;
    return;
  }
  const list = document.createElement("div");
  list.className = "commands-list";
  commands.forEach(cmd => list.appendChild(renderCommandCard(cmd)));
  commandsPanel.appendChild(list);
}

function renderCommandCard(entry: CommandEntry): HTMLElement {
  const card = document.createElement("details");
  card.className = "command-card";
  card.open = false;

  const summary = document.createElement("summary");
  summary.className = "command-summary";

  const summaryMain = document.createElement("div");
  summaryMain.className = "command-summary-main";

  const name = document.createElement("h3");
  name.className   = "cmd-name";
  name.textContent = entry.name;
  summaryMain.appendChild(name);

  if (entry.description) {
    const descPreview = document.createElement("p");
    descPreview.className = "cmd-desc cmd-desc-preview";
    descPreview.textContent = entry.description;
    summaryMain.appendChild(descPreview);
  }

  const toggle = document.createElement("span");
  toggle.className = "command-toggle";
  toggle.setAttribute("aria-hidden", "true");
  toggle.textContent = "▸";

  summary.append(summaryMain, toggle);

  card.appendChild(summary);

  const body = document.createElement("div");
  body.className = "command-body";

  if (entry.description) {
    const desc = document.createElement("p");
    desc.className   = "cmd-desc";
    desc.textContent = entry.description;
    body.appendChild(desc);
  }

  // ── Argument form ────────────────────────────────────────────────────────────
  const args = entry.args;
  const getters: (() => string | undefined)[] = [];
  const callingBox = document.createElement("div");
  callingBox.className = "calling-box";

  if (args.length > 0) {
    const form = document.createElement("div");
    form.className = "cmd-form";

    for (const arg of args) {
      const row = document.createElement("div");
      row.className = "arg-row";

      const lbl = document.createElement("label");
      lbl.className   = "arg-label";
      lbl.textContent = arg.name;

      const { el, getValue } = buildArgInput(arg);
      getters.push(getValue);

      row.append(lbl, el);

      if (arg.unit) {
        const u = document.createElement("span");
        u.className   = "arg-unit";
        u.textContent = arg.unit;
        row.appendChild(u);
      }

      form.appendChild(row);
    }
    callingBox.appendChild(form);
  } else {
    const empty = document.createElement("p");
    empty.className = "calling-box-empty";
    empty.textContent = "This command takes no arguments.";
    callingBox.appendChild(empty);
  }

  // ── Call button ───────────────────────────────────────────────────────────────
  const btn = document.createElement("button");
  btn.className   = "btn btn-outline call-btn";
  btn.textContent = "Call";

  btn.addEventListener("click", async () => {
    btn.disabled    = true;
    btn.textContent = "Calling…";

    const callArgs: string[] = [];
    for (const getValue of getters) {
      const v = getValue();
      if (v !== undefined) callArgs.push(v);
    }

    try {
      await device.sendCommand(entry.name, ...callArgs);
      
      // Sync the debug checkbox if setDebug was called via button
      if (entry.name === "setDebug" && callArgs.length === 1) {
        const arg = callArgs[0].toLowerCase();
        if (arg === "1" || arg === "true") {
          const checkbox = document.querySelector(".debug-toggle input[type=\"checkbox\"]") as HTMLInputElement | null;
          if (checkbox) {
            checkbox.checked = true;
            if (currentState) currentState.debug = true;
          }
        } else if (arg === "0" || arg === "false") {
          const checkbox = document.querySelector(".debug-toggle input[type=\"checkbox\"]") as HTMLInputElement | null;
          if (checkbox) {
            checkbox.checked = false;
            if (currentState) currentState.debug = false;
          }
        }
      }
    } catch (err) {
      consoleError(`${entry.name} failed.`, err);
    } finally {
      btn.disabled    = false;
      btn.textContent = "Call";
    }
  });

  callingBox.appendChild(btn);
  body.appendChild(callingBox);
  card.appendChild(body);
  return card;
}

// ─── Argument input factory ────────────────────────────────────────────────────

function buildArgInput(arg: ArgDef): { el: HTMLElement; getValue: () => string | undefined } {
  const baseType = arg.type.replace(/[^a-z]/gi, "").trim();

  // Choice list → <select>
  if (arg.choices && arg.choices.length > 0) {
    const wrap = document.createElement("div");
    wrap.className = "choice-input-wrap";

    const listId = `choice-${Math.random().toString(36).slice(2, 10)}`;
    const inp = document.createElement("input");
    inp.className = "arg-input choice-input";
    inp.type = "text";
    inp.placeholder = arg.name;
    inp.setAttribute("list", listId);

    const dl = document.createElement("datalist");
    dl.id = listId;
    for (const c of arg.choices) {
      const opt = document.createElement("option");
      opt.value = c;
      dl.appendChild(opt);
    }

    wrap.append(inp, dl);
    return {
      el: wrap,
      getValue: () => {
        if (inp.value === "") return "";
        return inp.value;
      },
    };
  }

  // Boolean → false/true select
  if (baseType === "bool") {
    const sel = document.createElement("select");
    sel.className = "arg-input";
    [["0", "false (0)"], ["1", "true (1)"]].forEach(([v, t]) => {
      const opt = document.createElement("option");
      opt.value = v; opt.textContent = t;
      sel.appendChild(opt);
    });
    return { el: sel, getValue: () => sel.value };
  }

  // Numeric types → <input type=number>
  if (["int", "uint", "long", "float"].includes(baseType)) {
    const inp = document.createElement("input");
    inp.className   = "arg-input";
    inp.type        = "number";
    inp.placeholder = arg.name;
    inp.step        = baseType === "float" ? "any" : "1";
    if (baseType === "float")  inp.step = "any";
    const getValue = () => {
      if (inp.value === "") return "";
      return inp.value;
    };
    return { el: inp, getValue };
  }

  // Default → text input
  const inp = document.createElement("input");
  inp.className   = "arg-input";
  inp.type        = "text";
  inp.placeholder = arg.name;
  const getValue = () => {
    if (inp.value === "") return "";
    return inp.value;
  };
  return { el: inp, getValue };
}
