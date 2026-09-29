// URLs and local file paths mentioned in a conversation, for the Refs tab.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(?:\/[^\s<>"'`]*)?/gi;
// Words that could be paths: /abs, ~/x, ./x, ../x, dir/file.ext, file.ext, with an optional :line or #L12.
const PATH_RE = /(?:~|\.{1,2})?\/?[\w@.+-]+(?:\/[\w@.+-]+)*\/?(?::\d+(?:[:-]\d+)?|#L\d+(?:-L?\d+)?)?/g;
const EXT = /\.[A-Za-z0-9]{1,8}$/;

// Drop sentence punctuation and closing brackets the address didn't open.
function trimUrl(url) {
  url = url.replace(/[.,;:!?*_]+$/, "");
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
    while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
  }
  return /^https?:\/\//i.test(url) ? url : `http://${url}`;
}

const exists = new Map(); // abs path -> bool, cached; files don't come and go often enough to matter here
function onDisk(p) {
  if (!exists.has(p)) { try { fs.statSync(p); exists.set(p, true); } catch { exists.set(p, false); } }
  return exists.get(p);
}

// One path-like word -> { value: absolute path, line } or null when it's probably prose ("and/or", "/loop").
function toPath(word, cwd) {
  const m = word.match(/^(.*?)(?::(\d+)(?:[:-]\d+)?|#L(\d+)(?:-L?\d+)?)?$/);
  let p = m[1].replace(/[.]+$/, "");
  const line = Number(m[2] || m[3]) || 0;
  if (!/[A-Za-z]/.test(p) || p.length < 3) return null;
  const abs = p.startsWith("~/") ? path.join(HOME, p.slice(2))
    : path.isAbsolute(p) ? path.normalize(p)
    : cwd ? path.resolve(cwd, p) : null;
  if (!abs) return null;
  const dotted = /^\.{1,2}\//.test(p) || p.startsWith("~/");
  const segments = p.split("/").filter(Boolean).length;
  // Absolute: two or more segments ("/loop" is a slash command). Relative: a file name with an
  // extension ("j/k" and "read/write" are prose). A bare "name.ext" only counts if it's there.
  const plausible = path.isAbsolute(p) ? segments >= 2
    : dotted ? true
    : p.includes("/") ? EXT.test(p) || onDisk(abs)
    : EXT.test(p) && onDisk(abs);
  if (!plausible || abs === "/" || abs === HOME) return null;
  return { value: abs.replace(/\/$/, ""), line };
}

// -> [{ kind: "url"|"file", value, line }]
export function extractRefs(text, cwd) {
  if (!text || typeof text !== "string") return [];
  const refs = [];
  const rest = text.replace(URL_RE, (u) => {
    if (!/[$*{}]/.test(u)) refs.push({ kind: "url", value: trimUrl(u), line: 0 }); // not shell templates like $BASE/x
    return " ";
  });
  for (const word of rest.match(PATH_RE) || []) {
    if (!word.includes("/") && !EXT.test(word.replace(/(?::\d+.*|#L.*)$/, ""))) continue; // cheap skip for plain words
    const p = toPath(word, cwd);
    if (p) refs.push({ kind: "file", ...p });
  }
  return refs;
}

// "~/x" for home, "x/y" inside the session's folder.
export function displayPath(p, cwd) {
  if (cwd && p.startsWith(cwd + "/")) return path.relative(cwd, p);
  return p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}
