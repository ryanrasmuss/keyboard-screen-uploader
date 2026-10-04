const SCRIPT_NAME = "play75-upload.py";
const RULES_NAME = "70-play75.rules";

/** True on desktop Linux (not Android or ChromeOS), where WebHID can't reach the screen's control channel. */
export function isLinux(): boolean {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  if (platform) return platform === "Linux";
  return /Linux/.test(navigator.userAgent) && !/Android|CrOS/.test(navigator.userAgent);
}

export interface LinuxPanel {
  exportBtn: HTMLButtonElement;
  /** Swaps the generic "run" command for one naming the file that was just saved. */
  showRunCommand(fileName: string): void;
}

function runCommand(fileName: string): string {
  return `python3 ~/Downloads/${SCRIPT_NAME} ~/Downloads/${fileName}`;
}

/**
 * The "On Linux?" workflow: export the exact payload the WebHID upload would
 * send as a .bin, then upload it with a small local script that reaches the
 * control channel over usbfs. Rendered from here so both pages share one copy
 * of the instructions. Opens by default on Linux.
 */
export function renderLinuxPanel(panel: HTMLDetailsElement): LinuxPanel {
  panel.open = isLinux();
  panel.innerHTML = `
    <summary>On Linux? Upload with a small script instead</summary>
    <div class="linux-body">
      <p>
        On Linux, the browser can't reach the keyboard screen's control channel (the kernel
        won't attach to it), so <strong>Connect keyboard</strong> won't work. Instead, download
        the prepared animation here and send it with a small Python script. No extra packages needed.
      </p>

      <p class="linux-step-title">One-time setup</p>
      <ol>
        <li>
          Download <a href="/linux/${SCRIPT_NAME}" download>${SCRIPT_NAME}</a> and
          <a href="/linux/${RULES_NAME}" download>${RULES_NAME}</a> to your Downloads folder.
        </li>
        <li>
          Install the udev rule so the script can talk to the keyboard without <code>sudo</code>,
          then unplug and replug the keyboard:
          <pre><code>sudo cp ~/Downloads/${RULES_NAME} /etc/udev/rules.d/
sudo udevadm control --reload
sudo udevadm trigger</code></pre>
        </li>
      </ol>

      <p class="linux-step-title">Each upload</p>
      <ol>
        <li>
          Choose a file, crop, and optimize above, then
          <button type="button" class="linux-export-btn" disabled>Download .bin</button>
        </li>
        <li>
          Run:
          <pre><code class="linux-run-cmd">${runCommand("&lt;file&gt;.bin")}</code></pre>
        </li>
      </ol>
      <p class="linux-note">
        The script also syncs the screen clock. To sync just the clock, run
        <code>python3 ~/Downloads/${SCRIPT_NAME} --clock-only</code>.
      </p>
    </div>
  `;

  const exportBtn = panel.querySelector<HTMLButtonElement>(".linux-export-btn")!;
  const runCmd = panel.querySelector<HTMLElement>(".linux-run-cmd")!;
  return {
    exportBtn,
    showRunCommand(fileName) {
      runCmd.textContent = runCommand(fileName);
    },
  };
}
