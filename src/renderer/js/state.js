// Application-wide state shared by pages and dialogs (filled in by app.js at boot).
import { emitter } from "./dom.js";

export const app = {
  info: null,          // app.info (version, paths, startup report)
  caps: null,          // app.capabilities (ffmpeg, tts, captions)
  settings: null,      // settings.all()
  shortcuts: null,     // { id, bindings, conflicts, commands }
  events: emitter(),   // "settings", "route", "shortcuts"
  notifications: [],   // in-session notifications (export finished/failed, backups…)
  go: null,            // (route, params) => void
  current: null,       // { route, params }
};

export function setting(section, key) { return app.settings?.[section]?.[key]; }

export function pushNotification(n) {
  app.notifications.unshift({ id: Math.random().toString(36).slice(2), at: new Date().toISOString(), ...n });
  app.notifications = app.notifications.slice(0, 100);
  app.events.emit("notifications", app.notifications);
}

export async function refreshSettings() {
  app.settings = await window.api.call("settings.all");
  app.events.emit("settings", app.settings);
  return app.settings;
}
