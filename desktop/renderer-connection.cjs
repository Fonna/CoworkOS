/** Cookie installation belongs to the session even while a Mac window is closed. */
async function connectRenderer(backend, cookies, getWindow) {
  await cookies.set({
    url: backend.url,
    name: "atria-session",
    value: backend.token,
    httpOnly: true,
    sameSite: "strict"
  });
  const window = getWindow();
  if (window && !window.isDestroyed()) await window.loadURL(backend.url);
}

module.exports = { connectRenderer };
