// The UI's icons as inline SVG: Phosphor (MIT) for chrome, game-icons.net
// (CC BY 3.0, credited in NOTICE.md and on the config page) for dungeon
// accents. Each file is bundled as text and parsed once; every use is a
// clone, sized by CSS and coloured by currentColor.

import enterKey from "@phosphor-icons/core/assets/bold/arrow-elbow-down-left-bold.svg" with {
  type: "text",
};
import arrowLeft from "@phosphor-icons/core/assets/bold/arrow-left-bold.svg" with {
  type: "text",
};
import arrowRight from "@phosphor-icons/core/assets/bold/arrow-right-bold.svg" with {
  type: "text",
};
import close from "@phosphor-icons/core/assets/bold/x-bold.svg" with {
  type: "text",
};
import checkCircle from "@phosphor-icons/core/assets/duotone/check-circle-duotone.svg" with {
  type: "text",
};
import doorOpen from "@phosphor-icons/core/assets/duotone/door-open-duotone.svg" with {
  type: "text",
};
import floppy from "@phosphor-icons/core/assets/duotone/floppy-disk-duotone.svg" with {
  type: "text",
};
import gear from "@phosphor-icons/core/assets/duotone/gear-duotone.svg" with {
  type: "text",
};
import hash from "@phosphor-icons/core/assets/duotone/hash-duotone.svg" with {
  type: "text",
};
import key from "@phosphor-icons/core/assets/duotone/key-duotone.svg" with {
  type: "text",
};
import play from "@phosphor-icons/core/assets/duotone/play-duotone.svg" with {
  type: "text",
};
import shuffle from "@phosphor-icons/core/assets/duotone/shuffle-duotone.svg" with {
  type: "text",
};
import stack from "@phosphor-icons/core/assets/duotone/stack-duotone.svg" with {
  type: "text",
};
import terminal from "@phosphor-icons/core/assets/duotone/terminal-window-duotone.svg" with {
  type: "text",
};
import trash from "@phosphor-icons/core/assets/duotone/trash-duotone.svg" with {
  type: "text",
};
import warning from "@phosphor-icons/core/assets/duotone/warning-circle-duotone.svg" with {
  type: "text",
};
import gameCityCar from "./icons/game/city-car.svg" with { type: "text" };
import gameCrossroad from "./icons/game/crossroad.svg" with { type: "text" };
import gameDice from "./icons/game/dice-six-faces-five.svg" with {
  type: "text",
};
import gameDungeonGate from "./icons/game/dungeon-gate.svg" with {
  type: "text",
};
import gameCloud from "./icons/game/fluffy-cloud.svg" with { type: "text" };
import gameHorizonRoad from "./icons/game/horizon-road.svg" with {
  type: "text",
};
import gameProcessor from "./icons/game/processor.svg" with { type: "text" };
import gameRuleBook from "./icons/game/rule-book.svg" with { type: "text" };
import gameTorch from "./icons/game/torch.svg" with { type: "text" };
import gameTrafficCone from "./icons/game/traffic-cone.svg" with {
  type: "text",
};
import gameTrafficLights from "./icons/game/traffic-lights-red.svg" with {
  type: "text",
};

const SOURCES = {
  // Phosphor: chrome.
  arrowLeft,
  arrowRight,
  enterKey,
  close,
  checkCircle,
  doorOpen,
  floppy,
  gear,
  hash,
  key,
  play,
  shuffle,
  stack,
  terminal,
  trash,
  warning,
  // game-icons.net: dungeon accents.
  dungeonGate: gameDungeonGate,
  cityCar: gameCityCar,
  trafficLights: gameTrafficLights,
  crossroad: gameCrossroad,
  horizonRoad: gameHorizonRoad,
  trafficCone: gameTrafficCone,
  ruleBook: gameRuleBook,
  dice: gameDice,
  torch: gameTorch,
  processor: gameProcessor,
  cloud: gameCloud,
} as const;

export type IconName = keyof typeof SOURCES;

const parsed = new Map<IconName, SVGElement>();

function template(name: IconName): SVGElement {
  let svg = parsed.get(name);
  if (!svg) {
    // The sources are this project's own bundled files, never user input.
    const doc = new DOMParser().parseFromString(SOURCES[name], "image/svg+xml");
    svg = doc.documentElement as unknown as SVGElement;
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    parsed.set(name, svg);
  }
  return svg;
}

/** A decorative icon; give it a class to size or colour it. */
export function svgIcon(name: IconName, className = ""): SVGElement {
  const svg = document.importNode(template(name), true) as SVGElement;
  svg.setAttribute(
    "class",
    `icon icon-${name}${className ? ` ${className}` : ""}`,
  );
  return svg;
}
