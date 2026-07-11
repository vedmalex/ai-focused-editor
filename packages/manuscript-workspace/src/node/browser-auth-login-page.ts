// *****************************************************************************
// Server-rendered login page asset for the optional browser-auth gate.
//
// This is intentionally a self-contained, dependency-free HTML/CSS string so it
// can be served BEFORE any Theia frontend bundle loads (an unauthenticated peer
// must never receive the app shell). UI strings are Russian (the product's
// primary locale); see docs/auth.md.
// *****************************************************************************

import { AuthRoutes } from '../common/browser-auth-protocol';

const STRINGS = {
  title: 'Вход — AI Focused Editor',
  heading: 'AI Focused Editor',
  subheading: 'Требуется вход',
  passwordLabel: 'Пароль или токен доступа',
  passwordPlaceholder: 'Введите пароль…',
  submit: 'Войти',
  invalid: 'Неверный пароль или токен. Попробуйте ещё раз.',
  hint: 'Доступ к этому редактору защищён. Введите общий секрет, заданный администратором.'
};

export const LOGIN_PAGE_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: #1e1e1e;
  color: #e0e0e0;
}
.card {
  width: 100%;
  max-width: 360px;
  margin: 24px;
  padding: 32px;
  border-radius: 12px;
  background: #252526;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.4);
}
h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
.subheading { margin: 0 0 20px; font-size: 14px; color: #9d9d9d; }
label { display: block; margin-bottom: 6px; font-size: 13px; color: #cccccc; }
input[type="password"] {
  width: 100%;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid #3c3c3c;
  background: #1e1e1e;
  color: #e0e0e0;
  font-size: 14px;
}
input[type="password"]:focus { outline: none; border-color: #0e639c; }
button {
  width: 100%;
  margin-top: 16px;
  padding: 10px 12px;
  border: none;
  border-radius: 6px;
  background: #0e639c;
  color: #ffffff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
button:hover { background: #1177bb; }
.error {
  margin: 12px 0 0;
  padding: 8px 12px;
  border-radius: 6px;
  background: #5a1d1d;
  color: #f4b8b8;
  font-size: 13px;
}
.hint { margin-top: 18px; font-size: 12px; color: #7a7a7a; line-height: 1.5; }
`.trim();

/** Render the login page. `error` toggles the invalid-credentials banner. */
export function renderLoginPage(options: { error?: boolean } = {}): string {
  const errorBanner = options.error
    ? `<p class="error">${STRINGS.invalid}</p>`
    : '';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${STRINGS.title}</title>
<link rel="stylesheet" href="${AuthRoutes.loginStyle}" />
</head>
<body>
<main class="card">
<h1>${STRINGS.heading}</h1>
<p class="subheading">${STRINGS.subheading}</p>
<form method="POST" action="${AuthRoutes.login}" autocomplete="off">
<label for="password">${STRINGS.passwordLabel}</label>
<input id="password" name="password" type="password" placeholder="${STRINGS.passwordPlaceholder}" autofocus required />
${errorBanner}
<button type="submit">${STRINGS.submit}</button>
</form>
<p class="hint">${STRINGS.hint}</p>
</main>
</body>
</html>`;
}
