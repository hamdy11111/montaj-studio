// Component name (core/graphicsKit.js `component`) → React component.
import * as punchy from "./kit/punchy.jsx";
import * as numbers from "./kit/numbers.jsx";
import * as text from "./kit/text.jsx";
import * as extras from "./kit/extras.jsx";

export const COMPONENTS = { ...punchy, ...numbers, ...text, ...extras };
