import { chromium } from "playwright";
import axios from "axios";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config();

const API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = process.env.OPENAI_BASE_URL;
const BRAVE_CDP_URL = process.env.BRAVE_CDP_URL || "http://127.0.0.1:9222";

// Platform-specific browser paths
const getPlatformBrowserPaths = () => {
  const platform = process.platform;
  
  if (platform === "darwin") {
    // macOS paths
    return {
      brave: [
        "/Applications/Brave Browser.app",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
      ],
      chrome: [
        "/Applications/Google Chrome.app",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      ]
    };
  } else if (platform === "win32") {
    // Windows paths
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesx86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return {
      brave: [
        path.join(programFiles, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
        path.join(programFilesx86, "BraveSoftware\\Brave-Browser\\Application\\brave.exe")
      ],
      chrome: [
        path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
        path.join(programFilesx86, "Google\\Chrome\\Application\\chrome.exe")
      ]
    };
  } else {
    // Linux and other Unix-like systems
    return {
      brave: [
        "/usr/bin/brave-browser",
        "/usr/bin/brave",
        "/snap/bin/brave"
      ],
      chrome: [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/snap/bin/chromium"
      ]
    };
  }
};

const browserPaths = getPlatformBrowserPaths();

function isBraveInstalled() {
  return browserPaths.brave.some(p => fs.existsSync(p));
}

function isChromeInstalled() {
  return browserPaths.chrome.some(p => fs.existsSync(p));
}

async function launchChromeBrowser() {
  if (!isChromeInstalled()) {
    throw new Error("Google Chrome n'est pas installe sur cette machine.");
  }

  return chromium.launch({ channel: "chrome", headless: false });
}

async function callLLM(prompt, imageUrls = []) {
  const userContent = [{ type: "text", text: prompt }];

  for (const url of imageUrls.slice(0, 6)) {
    userContent.push({
      type: "image_url",
      image_url: { url }
    });
  }

  const res = await axios.post(
    `${BASE_URL}/chat/completions`,
    {
      model: process.env.OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are an English multiple-choice exam assistant. You must answer directly from provided content and never ask for more information."
        },
        { role: "user", content: userContent }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 45000
    }
  );

  return res.data.choices[0].message.content;
}

async function extractVisibleImageContext(page) {
  const uniqueUrls = new Set();
  const descriptions = [];

  for (const frame of page.frames()) {
    const images = await frame
      .evaluate(() => {
        const isVisible = el => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 20 && rect.height > 20;
        };

        const compact = s => (s || "").replace(/\s+/g, " ").trim();

        return Array.from(document.querySelectorAll("img"))
          .filter(isVisible)
          .slice(0, 25)
          .map((img, i) => {
            const src = img.currentSrc || img.src || "";
            const alt = compact(img.getAttribute("alt") || "");
            const title = compact(img.getAttribute("title") || "");
            const nearby = compact(img.closest("figure, .image, #question-content, #question-wrapper")?.innerText || "")
              .slice(0, 220);
            return {
              src,
              description: `Image ${i + 1}: alt=${alt || "(none)"}; title=${title || "(none)"}; nearby=${nearby || "(none)"}`
            };
          })
          .filter(x => x.src);
      })
      .catch(() => []);

    for (const img of images) {
      if (!uniqueUrls.has(img.src)) {
        uniqueUrls.add(img.src);
        descriptions.push(img.description);
      }
    }
  }

  return {
    imageUrls: Array.from(uniqueUrls),
    imageSummary: descriptions.slice(0, 10).join("\n")
  };
}

async function extractStructuredQuestionContext(page) {
  const chunks = [];

  for (const frame of page.frames()) {
    const context = await frame
      .evaluate(() => {
        const isVisible = el => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const compact = s => (s || "").replace(/\s+/g, " ").trim();
        const wrappers = Array.from(document.querySelectorAll("#question-wrapper")).filter(isVisible);
        if (wrappers.length === 0) return "";

        const blocks = [];

        wrappers.forEach((wrapper, i) => {
          const title = compact(wrapper.querySelector("#question-header")?.innerText || "");
          const names = [];
          const seen = new Set();

          const radios = Array.from(wrapper.querySelectorAll('input[type="radio"][name]')).filter(isVisible);
          for (const radio of radios) {
            const name = radio.getAttribute("name") || "";
            if (!name || seen.has(name)) continue;
            seen.add(name);
            names.push(name);
          }

          const optionLines = [];
          names.forEach(name => {
            const group = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`));
            const opts = [];

            for (const input of group) {
              const id = input.getAttribute("id");
              if (!id) continue;
              const label = document.querySelector(`label[for="${id}"]`);
              if (!label || !isVisible(label)) continue;
              const txt = compact(label.textContent || "");
              if (txt) opts.push(txt);
            }

            if (opts.length > 0) optionLines.push(opts.join(" | "));
          });

          const optionText = optionLines.length > 0 ? optionLines.join(" || ") : "(options not found)";
          blocks.push(`Q${i + 1}: ${title}\nOPTIONS: ${optionText}`);
        });

        return blocks.join("\n\n");
      })
      .catch(() => "");

    if (context) chunks.push(context);
  }

  return chunks.join("\n\n");
}

async function exploreDocumentTabsAndScroll(page) {
  for (const frame of page.frames()) {
    await frame
      .evaluate(() => {
        const isVisible = el => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const compact = s => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

        const tabLikes = Array.from(document.querySelectorAll('button, [role="tab"], a')).filter(isVisible);
        const tabKeywords = /document|docs?|texte|text|support|annexe|instruction|consigne|tab/i;

        for (const el of tabLikes) {
          const txt = compact(el.textContent || "");
          const aria = compact(el.getAttribute("aria-label") || "");
          const title = compact(el.getAttribute("title") || "");
          const bag = `${txt} ${aria} ${title}`;
          if (tabKeywords.test(bag)) {
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          }
        }

        const scrollers = Array.from(document.querySelectorAll("*"))
          .filter(isVisible)
          .filter(el => el.scrollHeight - el.clientHeight > 120)
          .slice(0, 20);

        for (const node of scrollers) {
          node.scrollTop = node.scrollHeight;
        }
        window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
      })
      .catch(() => {});
  }

  await page.waitForTimeout(350);
}

function fingerprint(content) {
  return `${content.length}:${content.slice(0, 220)}`;
}

function parseClockToSeconds(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  const parts = trimmed.split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

async function detectAudioDurationSeconds(page) {
  let best = null;

  for (const frame of page.frames()) {
    const candidate = await frame
      .evaluate(() => {
        const values = [];

        const mediaNodes = Array.from(document.querySelectorAll("audio, video"));
        for (const node of mediaNodes) {
          const d = Number(node.duration);
          if (Number.isFinite(d) && d > 0) values.push(Math.round(d));
        }

        const fullText = document.body?.innerText || "";
        const slashMatches = fullText.match(/\b\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}\b/g) || [];
        for (const block of slashMatches) {
          const right = block.split("/")[1]?.trim();
          if (right) values.push(right);
        }

        return values;
      })
      .catch(() => []);

    for (const value of candidate) {
      const seconds = typeof value === "number" ? value : parseClockToSeconds(value);
      if (!Number.isFinite(seconds) || seconds <= 0) continue;
      if (!best || seconds > best) best = seconds;
    }
  }

  return best;
}

async function waitForCoherentDuration(page, exerciseStartedAtMs, targetDurationSec, reasonLabel) {
  const minDurationSec = targetDurationSec || 0;
  const format = total => {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  if (minDurationSec <= 0) {
    return;
  }

  while (true) {
    const elapsedSec = Math.floor((Date.now() - exerciseStartedAtMs) / 1000);
    const remainingSec = Math.max(0, minDurationSec - elapsedSec);

    if (remainingSec <= 0) {
      console.log("⏱️ Attente terminee, progression possible.");
      return;
    }

    console.log(
      `⏱️ Temps restant avant progression: ${format(remainingSec)} (${reasonLabel}=${format(minDurationSec)})`
    );

    const stepSec = remainingSec > 60 ? 10 : 5;
    await page.waitForTimeout(stepSec * 1000);
  }
}

function parseLetterAnswers(answerText, questionCount) {
  const map = new Map();
  const lineRegex = /(?:^|\n)\s*(\d+)\s*[).:-]\s*([ABCD])\b/gi;
  let match = lineRegex.exec(answerText);

  while (match) {
    const index = Number(match[1]);
    const letter = String(match[2] || "").toUpperCase();
    if (index > 0 && index <= questionCount) map.set(index, letter);
    match = lineRegex.exec(answerText);
  }

  if (map.size > 0) {
    const ordered = [];
    for (let i = 1; i <= questionCount; i += 1) {
      ordered.push(map.get(i) || null);
    }
    return ordered;
  }

  return [];
}

function parseBlankAnswers(answerText, blankCount) {
  if (blankCount <= 0) return [];

  const lines = String(answerText || "").split(/\r?\n/);
  const answers = [];
  let inBlanks = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^BLANKS\s*:?$/i.test(line)) {
      inBlanks = true;
      continue;
    }
    if (/^RADIOS\s*:?$/i.test(line)) {
      inBlanks = false;
      continue;
    }
    if (!inBlanks) continue;

    const m = line.match(/^(\d+)\s*[).:-]\s*(.+)$/);
    if (!m) continue;

    const index = Number(m[1]);
    const value = (m[2] || "").trim();
    if (!index || !value) continue;
    answers[index - 1] = value;
  }

  return Array.from({ length: blankCount }, (_, i) => answers[i] || null);
}

async function normalizeAnswerLettersWithLLM(rawAnswer, questionCount) {
  const prompt = `
You will receive an exam assistant answer.
Convert it into ONLY this format with one letter per line:
1: A
2: B
...

Rules:
- Exactly ${questionCount} lines
- Use only A, B, C, or D
- No explanations, no markdown, no extra text

Input:
${rawAnswer}
`;

  return callLLM(prompt);
}

function findGlobalExamPage(browser) {
  const pages = browser.contexts().flatMap(context => context.pages());
  const globalPages = pages.filter(p => p.url().includes("global-exam.com"));

  if (globalPages.length > 0) {
    const exercisePage = globalPages.find(p => /exercise|training|toeic|ielts|lesson/i.test(p.url()));
    return exercisePage || globalPages[globalPages.length - 1];
  }

  return pages[pages.length - 1] || null;
}

async function revealTranscripts(page) {
  // Try to open transcript panels when they are hidden behind buttons/links.
  const toggles = page.locator(
    'button, a, [role="button"], summary, [aria-label*="transcript" i], [title*="transcript" i]'
  );
  const count = await toggles.count();

  for (let i = 0; i < count; i += 1) {
    const el = toggles.nth(i);
    const label = ((await el.innerText().catch(() => "")) || "").trim();
    const aria = ((await el.getAttribute("aria-label").catch(() => "")) || "").trim();
    const title = ((await el.getAttribute("title").catch(() => "")) || "").trim();
    const haystack = `${label} ${aria} ${title}`.toLowerCase();

    if (/(transcript|script|subtitles?|captions?|voir le transcript|show transcript|afficher)/i.test(haystack)) {
      await el.click({ timeout: 1200 }).catch(() => {});
      await page.waitForTimeout(250);
    }
  }
}

async function closeBlockingModals(page) {
  let closed = 0;

  for (const frame of page.frames()) {
    const count = await frame
      .evaluate(() => {
        const isVisible = el => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const selectors = [
          'button[data-testid="close-modal"]',
          'button[aria-label="Fermer la pop-in"]',
          'button[aria-label*="Fermer"]',
          'button[aria-label*="Close"]'
        ];

        let localClosed = 0;
        for (const selector of selectors) {
          const btn = document.querySelector(selector);
          if (!btn || !isVisible(btn)) continue;
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          localClosed += 1;
        }

        return localClosed;
      })
      .catch(() => 0);

    closed += count;
  }

  // Escape is a common close action for pop-ins.
  await page.keyboard.press("Escape").catch(() => {});
  if (closed > 0) {
    await page.waitForTimeout(250);
  }

  return closed;
}

async function extractExerciseContent(page) {
  const extractFromFrame = async frame =>
    frame
      .evaluate(() => {
        const normalize = s => (s || "").replace(/\s+/g, " ").trim();
        const chunks = new Set();

        const pushTexts = nodes => {
          for (const node of nodes) {
            const txt = normalize(node.innerText || node.textContent || "");
            if (txt.length >= 40) chunks.add(txt);
          }
        };

        pushTexts(document.querySelectorAll("h1, h2, h3, p, li, span, div"));
        pushTexts(
          document.querySelectorAll(
            [
              '[class*="transcript" i]',
              '[id*="transcript" i]',
              '[data-testid*="transcript" i]',
              '[class*="subtitle" i]',
              '[class*="caption" i]',
              '[class*="script" i]',
              'section[aria-label*="transcript" i]'
            ].join(",")
          )
        );

        return Array.from(chunks)
          .filter(t => t.length > 80)
          .join("\n\n");
      })
      .catch(() => "");

  const parts = [];
  for (const frame of page.frames()) {
    const text = await extractFromFrame(frame);
    if (text) parts.push(text);
  }

  return parts.join("\n\n");
}

async function getRadioQuestionCount(page) {
  let maxCount = 0;

  for (const frame of page.frames()) {
    const count = await frame
      .evaluate(() => {
        const names = new Set(
          Array.from(document.querySelectorAll('input[type="radio"][name]'))
            .map(el => el.getAttribute("name") || "")
            .filter(Boolean)
        );
        return names.size;
      })
      .catch(() => 0);

    if (count > maxCount) maxCount = count;
  }

  return maxCount;
}

async function getBlankFieldCount(page) {
  let maxCount = 0;

  for (const frame of page.frames()) {
    const count = await frame
      .evaluate(() => {
        const isVisible = el => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const fields = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']"));
        const fillable = fields.filter(el => {
          if (!isVisible(el)) return false;
          if (el.tagName === "TEXTAREA") return true;
          if (el.getAttribute("contenteditable") === "true") return true;
          if (el.tagName === "INPUT") {
            const type = (el.getAttribute("type") || "text").toLowerCase();
            return ["text", "search", "email", "tel", "url", "number"].includes(type);
          }
          return false;
        });

        return fillable.length;
      })
      .catch(() => 0);

    if (count > maxCount) maxCount = count;
  }

  return maxCount;
}

async function fillBlankAnswers(page, blanks) {
  if (!blanks || blanks.length === 0) return 0;
  let filled = 0;

  for (const frame of page.frames()) {
    const inFrame = await frame
      .evaluate(values => {
        const isVisible = el => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const fields = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']")).filter(
          el => {
            if (!isVisible(el)) return false;
            if (el.tagName === "TEXTAREA") return true;
            if (el.getAttribute("contenteditable") === "true") return true;
            if (el.tagName === "INPUT") {
              const type = (el.getAttribute("type") || "text").toLowerCase();
              return ["text", "search", "email", "tel", "url", "number"].includes(type);
            }
            return false;
          }
        );

        let count = 0;
        for (let i = 0; i < fields.length && i < values.length; i += 1) {
          const value = String(values[i] || "").trim();
          if (!value) continue;

          const field = fields[i];
          if (field.getAttribute("contenteditable") === "true") {
            field.textContent = value;
            field.dispatchEvent(new Event("input", { bubbles: true }));
            field.dispatchEvent(new Event("change", { bubbles: true }));
            count += 1;
            continue;
          }

          field.value = value;
          field.dispatchEvent(new Event("input", { bubbles: true }));
          field.dispatchEvent(new Event("change", { bubbles: true }));
          count += 1;
        }

        return count;
      }, blanks)
      .catch(() => 0);

    filled += inFrame;
  }

  return filled;
}

async function applyRadioAnswers(page, letters) {
  if (!letters || letters.length === 0) return 0;

  let selected = 0;

  for (const frame of page.frames()) {
    const inFrame = await frame
      .evaluate(answerLetters => {
        const radios = Array.from(document.querySelectorAll('input[type="radio"][name]'));
        if (radios.length === 0) return 0;

        const names = [];
        const seen = new Set();
        for (const radio of radios) {
          const name = radio.getAttribute("name") || "";
          if (!name || seen.has(name)) continue;
          seen.add(name);
          names.push(name);
        }

        let count = 0;

        for (let i = 0; i < names.length && i < answerLetters.length; i += 1) {
          const wanted = String(answerLetters[i] || "").toUpperCase();
          if (!/^[ABCD]$/.test(wanted)) continue;

          const group = radios.filter(r => r.getAttribute("name") === names[i]);
          let clicked = false;

          for (const input of group) {
            const id = input.getAttribute("id");
            if (!id) continue;
            const label = document.querySelector(`label[for="${id}"]`);
            if (!label) continue;
            const labelText = (label.textContent || "").replace(/\s+/g, " ").trim().toUpperCase();
            if (labelText === wanted || labelText.startsWith(`${wanted} `)) {
              input.checked = true;
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
              clicked = true;
              count += 1;
              break;
            }
          }

          if (!clicked) {
            const fallbackIndex = { A: 0, B: 1, C: 2, D: 3 }[wanted];
            const fallbackInput = group[fallbackIndex];
            if (fallbackInput) {
              fallbackInput.checked = true;
              fallbackInput.dispatchEvent(new Event("input", { bubbles: true }));
              fallbackInput.dispatchEvent(new Event("change", { bubbles: true }));
              count += 1;
            }
          }
        }

        return count;
      }, letters)
      .catch(() => 0);

    selected += inFrame;
  }

  return selected;
}

async function connectToBrave() {
  if (!isBraveInstalled()) {
    console.log("ℹ️ Brave non installe, ouverture de Chrome par defaut...");
    const browser = await launchChromeBrowser();
    const page = await browser.newPage();
    return { browser, page };
  }

  try {
    const browser = await chromium.connectOverCDP(BRAVE_CDP_URL);
    let page = findGlobalExamPage(browser);

    if (!page) {
      const context = browser.contexts()[0] || (await browser.newContext());
      page = await context.newPage();
    }

    return { browser, page };
  } catch (error) {
    console.error("❌ Impossible de se connecter a Brave via CDP.");
    console.error(`URL CDP utilisee: ${BRAVE_CDP_URL}`);
    console.error("Si Brave est installe, lance-le avec le port debug:");
    console.error('   open -a "Brave Browser" --args --remote-debugging-port=9222');
    console.error("Sinon, le script peut utiliser Chrome de base si tu le lances directement.");

    console.log("ℹ️ Fallback vers Chrome de base...");
    const browser = await launchChromeBrowser();
    const page = await browser.newPage();
    return { browser, page };
  }
}

async function clickProgressButton(page) {
  const selectors = [
    'button:has-text("Passer")',
    'button:has-text("Skip")',
    'button:has-text("Validate")',
    'button:has-text("Valider")',
    'button:has-text("Next")',
    'button:has-text("Suivant")',
    'button:has-text("Continue")',
    'button:has-text("Check")',
    'button:has-text("Terminer")',
    'button[type="submit"]'
  ];

  for (const selector of selectors) {
    const btn = page.locator(selector).first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click({ timeout: 1500 }).catch(() => {});
      return true;
    }
  }

  return false;
}

async function waitForExerciseReady(page) {
  console.log("⏳ Attente du chargement complet avant analyse...");

  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  let stableHits = 0;
  let lastLen = -1;

  for (let i = 0; i < 12; i += 1) {
    const state = await page
      .evaluate(() => {
        const isVisible = el => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const loadingSelectors = [
          '[aria-busy="true"]',
          '[data-testid*="loading" i]',
          '[data-testid*="loader" i]',
          '.loading',
          '.loader',
          '.spinner',
          '[class*="loading" i]',
          '[class*="spinner" i]'
        ];

        const hasVisibleLoader = loadingSelectors.some(selector => {
          const nodes = Array.from(document.querySelectorAll(selector));
          return nodes.some(isVisible);
        });

        const textLen = (document.body?.innerText || "").replace(/\s+/g, " ").trim().length;
        return {
          readyState: document.readyState,
          hasVisibleLoader,
          textLen
        };
      })
      .catch(() => ({ readyState: "loading", hasVisibleLoader: true, textLen: 0 }));

    const isStableLen = state.textLen > 200 && Math.abs(state.textLen - lastLen) < 20;
    const isReady = state.readyState === "complete" && !state.hasVisibleLoader && state.textLen > 200;

    if (isReady && isStableLen) {
      stableHits += 1;
    } else {
      stableHits = 0;
    }

    lastLen = state.textLen;

    if (stableHits >= 2) {
      console.log("✅ Page chargee et stable.");
      return;
    }

    await page.waitForTimeout(500);
  }

  console.log("⚠️ Chargement long: poursuite de l'analyse avec l'etat actuel.");
}

(async () => {
  const { browser, page } = await connectToBrave();
  let lastHandledFingerprint = "";
  let idleLoopCount = 0;
  const exerciseStartByFingerprint = new Map();
  const textWaitByFingerprint = new Map();

  if (!page.url().includes("global-exam.com")) {
    await page.goto("https://global-exam.com");
  }

  console.log("➡️ Ouvre un exercice GlobalExam, je detecte l'onglet actif automatiquement...");
  await page.waitForTimeout(5000);

  while (true) {
    console.log("🔍 Analyse de la page...");

    const activePage = findGlobalExamPage(browser) || page;

    if (!activePage.url().includes("global-exam.com")) {
      console.log("⚠️ Aucun onglet GlobalExam detecte, nouvelle tentative...");
      await activePage.waitForTimeout(2000);
      continue;
    }

    await waitForExerciseReady(activePage);

    await revealTranscripts(activePage);
    await exploreDocumentTabsAndScroll(activePage);
    const content = await extractExerciseContent(activePage);
    const { imageUrls, imageSummary } = await extractVisibleImageContext(activePage);
    const structuredQuestions = await extractStructuredQuestionContext(activePage);
    const questionCount = await getRadioQuestionCount(activePage);
    const blankCount = await getBlankFieldCount(activePage);

    if (!content || content.length < 200) {
      console.log("⚠️ Pas assez de contenu detecte. Ouvre la question visible, puis j'essaie encore...");
      await activePage.waitForTimeout(2500);
      continue;
    }

    const currentFingerprint = fingerprint(content);
    if (!exerciseStartByFingerprint.has(currentFingerprint)) {
      exerciseStartByFingerprint.set(currentFingerprint, Date.now());
    }

    if (currentFingerprint === lastHandledFingerprint) {
      idleLoopCount += 1;
      if (idleLoopCount % 4 === 0) {
        console.log("⏳ En attente d'un nouvel exercice (ou d'un changement de question)...");
      }
      await activePage.waitForTimeout(1500);
      continue;
    }

    idleLoopCount = 0;

    console.log(`📄 Contenu detecte: ${content.length} caracteres`);
    if (questionCount > 0) {
      console.log(`🧩 Questions a choix detectees: ${questionCount}`);
    }
    if (blankCount > 0) {
      console.log(`📝 Champs a completer detectes: ${blankCount}`);
    }
    if (imageUrls.length > 0) {
      console.log(`🖼️ Images detectees: ${imageUrls.length}`);
    }
    console.log("🧠 Envoi au modele...");

    const prompt = `
  You are solving an English exam with high accuracy requirements.

  Context:
  Transcript and page text:
  ${content}

  Structured visible questions/options:
  ${structuredQuestions || "(not available)"}

  Image context:
  ${imageSummary || "(no visible image metadata)"}

  Critical rules:
  - Use ONLY the provided context.
  - Do NOT ask for additional information.
  - If evidence is weak, still choose the most likely answer from context clues.
  - Use images when relevant to infer answers.
  - Prefer grammatical, idiomatic, and context-consistent English.

  Reasoning protocol (internal, do not print it):
  1) First pass: draft answers quickly.
  2) Second pass: verify each answer against the exact wording and context.
  3) Third pass: check consistency across all answers, eliminate contradictions, and correct likely distractors.
  4) Final sanity check: grammar and natural English for blanks.

  Output requirements:
  - Return ONLY the exact template below.
  - No explanations, no markdown, no extra text.
  - For radios, use only A/B/C/D.
  - For blanks, provide concise final text.

  RADIOS:
  1: A
  2: B

  BLANKS:
  1: answer
  2: answer
  `;

    const answer = await callLLM(prompt, imageUrls);
    lastHandledFingerprint = currentFingerprint;

    console.log("\n💡 PROPOSITION:\n");
    console.log(answer);

    const closedBeforeSelection = await closeBlockingModals(activePage);
    if (closedBeforeSelection > 0) {
      console.log(`🪟 Modale fermee avant selection: ${closedBeforeSelection}`);
    }

    if (questionCount > 0) {
      let letters = parseLetterAnswers(answer, questionCount);

      if (letters.filter(Boolean).length < questionCount) {
        console.log("🛠️ Reformatage des reponses en format strict A/B/C/D...");
        const normalized = await normalizeAnswerLettersWithLLM(answer, questionCount);
        letters = parseLetterAnswers(normalized, questionCount);
      }

      const expectedAnswers = letters.filter(v => /^[ABCD]$/.test(String(v || "").toUpperCase())).length;

      if (expectedAnswers > 0) {
        const selected = await applyRadioAnswers(activePage, letters);
        console.log(`✅ Reponses cochees automatiquement: ${selected}/${expectedAnswers}`);

        if (selected < expectedAnswers) {
          console.log("⚠️ Toutes les reponses n'ont pas pu etre cochees. Je ne clique pas sur Passer.");
          await activePage.waitForTimeout(2000);
          continue;
        }
      } else {
        console.log("⚠️ Format de reponse non reconnu pour cocher automatiquement.");
        await activePage.waitForTimeout(2000);
        continue;
      }
    }

    if (blankCount > 0) {
      const blanks = parseBlankAnswers(answer, blankCount);
      const expectedBlanks = blanks.filter(v => String(v || "").trim().length > 0).length;

      if (expectedBlanks > 0) {
        const filled = await fillBlankAnswers(activePage, blanks);
        console.log(`✅ Champs remplis automatiquement: ${filled}/${expectedBlanks}`);
        if (filled < expectedBlanks) {
          console.log("⚠️ Tous les champs n'ont pas pu etre remplis. Je ne clique pas sur Passer.");
          await activePage.waitForTimeout(2000);
          continue;
        }
      }
    }

    const closedBeforeProgress = await closeBlockingModals(activePage);
    if (closedBeforeProgress > 0) {
      console.log(`🪟 Modale fermee avant progression: ${closedBeforeProgress}`);
    }

    const audioDurationSec = await detectAudioDurationSeconds(activePage);
    let waitTargetSec = 0;
    let waitReasonLabel = "audio";
    if (audioDurationSec) {
      console.log(`🎧 Duree audio detectee: ${audioDurationSec}s`);
      waitTargetSec = audioDurationSec;
      waitReasonLabel = "audio";
    } else {
      if (!textWaitByFingerprint.has(currentFingerprint)) {
        const randomWaitSec = (process.env.MAX_TEMPS_EXO ? parseInt(process.env.MAX_TEMPS_EXO) : 30) + Math.floor(Math.random() * (process.env.MAX_TEMPS_EXO ? parseInt(process.env.MAX_TEMPS_EXO) : 30));
        textWaitByFingerprint.set(currentFingerprint, randomWaitSec);
      }

      waitTargetSec = textWaitByFingerprint.get(currentFingerprint) || 30;
      waitReasonLabel = "texte";
      console.log(`📖 Exercice texte detecte: attente aleatoire cible ${waitTargetSec}s.`);
    }

    await waitForCoherentDuration(
      activePage,
      exerciseStartByFingerprint.get(currentFingerprint) || Date.now(),
      waitTargetSec,
      waitReasonLabel
    );

    console.log("⚙️ Tentative de validation/passage automatique...");
    const clicked = await clickProgressButton(activePage);
    if (!clicked) {
      console.log("ℹ️ Aucun bouton de progression detecte.");
    }

    let movedToNextExercise = false;
    for (let i = 0; i < 8; i += 1) {
      await activePage.waitForTimeout(1000);
      await revealTranscripts(activePage);
      const nextContent = await extractExerciseContent(activePage);
      if (nextContent && nextContent.length >= 200 && fingerprint(nextContent) !== currentFingerprint) {
        movedToNextExercise = true;
        break;
      }
    }

    if (!movedToNextExercise) {
      console.log("✅ Exo traite. Change d'exercice si besoin, je detecte automatiquement le nouveau.");
      await activePage.waitForTimeout(2000);
    }
  }
})();