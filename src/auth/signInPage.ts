import type { Response } from "express";

export interface SignInPageModel {
  requestId: string;
  siteName: string;
  clientName: string;
  redirectHost: string;
  writeRequested: boolean;
  error?: string;
  login?: string;
}

const esc = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );

const STYLE = `
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--text:#1c2330;--muted:#5b6575;--line:#d5dae2;--accent:#1f5fbf;--err-bg:#fdecec;--err:#a12020}
@media(prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1e232b;--text:#e8ebf0;--muted:#9aa4b3;--line:#374050;--accent:#6ea4f5;--err-bg:#3a1c1c;--err:#f3a3a3}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px;width:100%;max-width:420px}
h1{font-size:20px;margin:0 0 4px}
p{margin:0 0 16px;color:var(--muted);font-size:14px}
.who{color:var(--text)}
label{display:block;font-size:14px;font-weight:600;margin:14px 0 4px}
input[type=text],input[type=password]{width:100%;padding:10px 12px;font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:8px}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
.check{display:flex;gap:8px;align-items:flex-start;font-weight:400;margin-top:18px}
.check input{margin-top:4px}
.error{background:var(--err-bg);color:var(--err);border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:8px}
.row{display:flex;gap:10px;margin-top:22px}
button{flex:1;padding:11px;font:inherit;font-weight:600;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
@media(prefers-color-scheme:dark){button.primary{color:#10151d}}
.note{font-size:12px;margin:18px 0 0}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function secure(res: Response): void {
  res.set({
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
}

export function renderSignInPage(
  res: Response,
  model: SignInPageModel,
  status = 200,
): void {
  secure(res);
  const body = `
<h1>Sign in to ${esc(model.siteName)}</h1>
<p><span class="who">${esc(model.clientName)}</span> (returns to <span class="who">${esc(model.redirectHost)}</span>) is asking to work in Dolibarr as you. Only continue if you started this yourself.</p>
${model.error ? `<div class="error" role="alert">${esc(model.error)}</div>` : ""}
<form method="post" action="/signin" autocomplete="off">
<input type="hidden" name="request" value="${esc(model.requestId)}">
<label for="login">Dolibarr login</label>
<input id="login" name="login" type="text" required autofocus autocapitalize="none" spellcheck="false" maxlength="100" value="${esc(model.login ?? "")}">
<label for="password">Dolibarr password</label>
<input id="password" name="password" type="password" required maxlength="200">
${
  model.writeRequested
    ? `<label class="check"><input type="checkbox" name="allow_write" value="1" checked><span>Allow it to create and change records. Untick for look-ups only.</span></label>`
    : ""
}
<div class="row">
<button type="submit" name="action" value="cancel" formnovalidate>Cancel</button>
<button type="submit" name="action" value="signin" class="primary">Sign in</button>
</div>
</form>
<p class="note">Your password is checked by Dolibarr and is not stored. Everything the application does is done under your Dolibarr user, with your own permissions.</p>`;
  res.status(status).type("html").send(page(`Sign in to ${model.siteName}`, body));
}

export function renderMessagePage(
  res: Response,
  status: number,
  title: string,
  message: string,
): void {
  secure(res);
  res
    .status(status)
    .type("html")
    .send(page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`));
}
