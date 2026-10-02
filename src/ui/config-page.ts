// Settings: the deciders (the nuclis API's URL, the TypeSafe key)
// and each dungeon's default autopilot. The key is write-only: the page can
// set or remove it but only ever learns whether one is set.

import type { ConfigPatch, DeciderView } from "../contract/api.ts";
import type { AnyDungeon } from "../dungeons/dungeon.ts";
import { ApiError } from "./api.ts";
import { autopilotOptions, deciderIcon } from "./autopilot.ts";
import { type Child, h } from "./dom.ts";
import { artFor } from "./dungeon-art.ts";
import { orderedDungeons } from "./gate.ts";
import { type IconName, svgIcon } from "./icons.ts";
import { floor, sky } from "./sky.ts";
import type { Store } from "./store.ts";
import { backLink, topbar } from "./topbar.ts";

export interface ConfigActions {
  save(patch: ConfigPatch): Promise<void>;
  home(): void;
}

type Tone = "ok" | "warn" | "off";

function badge(tone: Tone, icon: IconName | null, text: string): HTMLElement {
  return h(
    "span",
    { class: `status status-${tone}` },
    icon
      ? svgIcon(icon)
      : h("i", { class: "status-dot", "aria-hidden": "true" }),
    text,
  );
}

function card(
  className: string,
  icon: SVGElement,
  title: string,
  status: HTMLElement | null,
  ...body: Child[]
): HTMLElement {
  return h(
    "section",
    { class: `settings-card ${className}` },
    h("header", { class: "card-head" }, icon, h("h2", {}, title), status),
    ...body,
  );
}

function field(label: string, control: HTMLElement, hint?: Child): HTMLElement {
  return h(
    "label",
    { class: "field" },
    h("span", { class: "field-label" }, label),
    control,
    hint ? h("small", { class: "field-hint" }, hint) : null,
  );
}

function inputGroup(icon: IconName, input: HTMLElement): HTMLElement {
  return h(
    "span",
    { class: "input-group" },
    svgIcon(icon, "input-icon"),
    input,
  );
}

/** One dungeon's default: a single select of every decider's models. */
function defaultSelect(
  dungeon: AnyDungeon,
  deciders: DeciderView[],
  current: { decider: string; model: string } | undefined,
  onChoose: (value: string) => void,
): HTMLSelectElement {
  const options = autopilotOptions(deciders);
  const groups = deciders.map((view) =>
    h(
      "optgroup",
      { label: view.label },
      options
        .filter((o) => o.decider === view.id)
        .map((o) =>
          h(
            "option",
            {
              value: `${o.decider}/${o.model}`,
              disabled: !!o.blocked,
            },
            o.blocked ? `${o.label} (${o.blocked})` : o.label,
          ),
        ),
    ),
  );
  const select = h(
    "select",
    {
      class: "select",
      name: `default-${dungeon.id}`,
      "aria-label": `Default autopilot for ${dungeon.title}`,
      onchange: (event: Event) =>
        onChoose((event.target as HTMLSelectElement).value),
    },
    h("option", { value: "" }, "Default: nuclis · laya-multilingual"),
    groups,
  );
  select.value = current ? `${current.decider}/${current.model}` : "";
  return select;
}

export function configPage(store: Store, actions: ConfigActions): HTMLElement {
  const { config, deciders, configError, configNotice } = store.get();
  const bar = topbar(actions.home, null, backLink(actions.home));
  const head = h(
    "header",
    { class: "settings-head" },
    h("h1", {}, svgIcon("gear", "title-icon"), "Settings"),
    h(
      "p",
      {},
      config
        ? [
            "Saved in ",
            h("code", {}, `${config.home}/config.json`),
            " (mode 600). Environment variables override the file.",
          ]
        : (configError ?? "Loading…"),
    ),
  );
  const page = (...children: Child[]) =>
    h(
      "main",
      { class: "config scene" },
      sky(),
      floor(),
      bar,
      h("div", { class: "settings" }, head, ...children),
    );
  if (!config || !deciders) return page();

  const say = (section: string, text: string, error = false) =>
    store.set({ configNotice: { section, text, error } });
  const run = async (section: string, patch: ConfigPatch, done: string) => {
    say(section, "Saving…");
    try {
      await actions.save(patch);
      say(section, done);
    } catch (error) {
      say(
        section,
        error instanceof ApiError ? error.message : "Could not save.",
        true,
      );
    }
  };
  const notice = (section: string) => {
    const mine = configNotice?.section === section ? configNotice : undefined;
    return h(
      "span",
      {
        class: `save-status${mine?.error ? " is-error" : mine ? " is-ok" : ""}`,
        role: "status",
      },
      mine && !mine.error && mine.text !== "Saving…"
        ? svgIcon("checkCircle")
        : null,
      mine?.error ? svgIcon("warning") : null,
      mine?.text ?? "",
    );
  };

  // nuclis.
  const nuclisView = deciders.find((d) => d.id === "nuclis");
  const found =
    !!nuclisView?.status.configured && nuclisView.status.reachable !== false;
  const fromEnv = config.nuclis.urlSource === "env";
  const url = h("input", {
    class: "input",
    type: "url",
    name: "nuclis-url",
    value: config.nuclis.url,
    spellcheck: "false",
    autocomplete: "off",
    disabled: fromEnv,
  });
  const nuclis = card(
    "card-nuclis",
    deciderIcon("nuclis", "card-icon"),
    "nuclis",
    found
      ? badge("ok", "checkCircle", nuclisView?.status.version ?? "running")
      : badge("warn", "warning", "not running"),
    h(
      "p",
      { class: "card-lede" },
      found
        ? "Local decision models, kept open by nuclis serve."
        : (nuclisView?.status.reason ??
            "The nuclis API did not answer. Start it with nuclis serve."),
    ),
    field(
      "API URL",
      h(
        "span",
        { class: "field-row" },
        inputGroup("plugs", url),
        badge(
          "off",
          null,
          fromEnv
            ? "NUCLIS_URL"
            : config.nuclis.urlSource === "file"
              ? "saved"
              : "default",
        ),
      ),
      fromEnv
        ? "Set by NUCLIS_URL; unset it to change this here."
        : "Where nuclis serve listens, ending in /v1.",
    ),
    h(
      "footer",
      { class: "card-foot" },
      notice("nuclis"),
      h(
        "button",
        {
          type: "button",
          class: "btn",
          disabled: fromEnv,
          onclick: () => {
            const value = url.value.trim();
            void run(
              "nuclis",
              { nuclis: { url: value === "" ? null : value } },
              "Saved",
            );
          },
        },
        svgIcon("floppy"),
        "Save",
      ),
    ),
  );

  // TypeSafe.
  const key = h("input", {
    class: "input",
    type: "password",
    name: "typesafe-key",
    placeholder: config.typesafe.keySet
      ? "Paste a new key to replace it"
      : "Paste a key",
    autocomplete: "off",
    spellcheck: "false",
  });
  const typesafe = card(
    "card-typesafe",
    deciderIcon("typesafe", "card-icon"),
    "TypeSafe Jev",
    config.typesafe.keySet
      ? badge(
          "ok",
          "key",
          config.typesafe.keySource === "env"
            ? "key from TYPESAFE_API_KEY"
            : "key saved",
        )
      : badge("warn", "warning", "no key"),
    h(
      "p",
      { class: "card-lede" },
      "Hosted Jev, billed per input token. The server keeps the key; this page never reads it back.",
    ),
    field("API key", inputGroup("key", key)),
    h(
      "footer",
      { class: "card-foot" },
      notice("typesafe"),
      config.typesafe.keySource === "file"
        ? h(
            "button",
            {
              type: "button",
              class: "btn btn-ghost btn-danger",
              onclick: () =>
                void run(
                  "typesafe",
                  { typesafe: { apiKey: null } },
                  "Key removed",
                ),
            },
            svgIcon("trash"),
            "Remove",
          )
        : null,
      h(
        "button",
        {
          type: "button",
          class: "btn",
          onclick: () => {
            const value = key.value.trim();
            if (!value) return say("typesafe", "Paste a key first.", true);
            key.value = "";
            void run("typesafe", { typesafe: { apiKey: value } }, "Key saved");
          },
        },
        svgIcon("floppy"),
        "Save key",
      ),
    ),
  );

  // Autopilot defaults.
  const defaults = card(
    "card-defaults",
    svgIcon("dungeonGate", "card-icon"),
    "Autopilot defaults",
    null,
    h(
      "p",
      { class: "card-lede" },
      "The autopilot each dungeon's lobby selects when you enter it.",
    ),
    h(
      "ul",
      { class: "default-list" },
      orderedDungeons().map((dungeon) => {
        const art = artFor(dungeon.id);
        const section = `default:${dungeon.id}`;
        return h(
          "li",
          { class: "default-row", style: `--dungeon:${art.accent}` },
          h(
            "span",
            { class: "default-name" },
            svgIcon(art.emblem, "default-emblem"),
            h("b", {}, dungeon.title),
            h("small", {}, `${dungeon.levels.length} levels`),
          ),
          defaultSelect(
            dungeon,
            deciders,
            config.autopilot[dungeon.id],
            (value) => {
              const [decider, model] = value.split("/");
              void run(
                section,
                {
                  autopilot: {
                    [dungeon.id]: decider && model ? { decider, model } : null,
                  },
                },
                "Saved",
              );
            },
          ),
          notice(section),
        );
      }),
    ),
  );

  const credits = h(
    "p",
    { class: "credits" },
    "Icons: ",
    h(
      "a",
      {
        href: "https://phosphoricons.com",
        target: "_blank",
        rel: "noreferrer",
      },
      "Phosphor",
    ),
    " (MIT); dungeon icons by Delapouite and Lorc from ",
    h(
      "a",
      { href: "https://game-icons.net", target: "_blank", rel: "noreferrer" },
      "game-icons.net",
    ),
    ", ",
    h(
      "a",
      {
        href: "https://creativecommons.org/licenses/by/3.0/",
        target: "_blank",
        rel: "noreferrer",
      },
      "CC BY 3.0",
    ),
    ". Fonts: Fraunces and DM Sans (OFL).",
  );

  return page(
    h(
      "div",
      { class: "settings-grid" },
      h(
        "div",
        { class: "settings-group" },
        h("h3", { class: "group-title" }, "Deciders"),
        nuclis,
        typesafe,
      ),
      h(
        "div",
        { class: "settings-group" },
        h("h3", { class: "group-title" }, "Dungeons"),
        defaults,
      ),
    ),
    credits,
  );
}
