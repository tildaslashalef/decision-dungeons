// The config page: autopilot defaults per dungeon, nuclis's binary and
// backend, the TypeSafe key. The key is write-only: the page can set or
// remove it but only ever learns whether one is set.

import { ArrowLeft } from "lucide";
import type { Backend, ConfigPatch } from "../contract/api.ts";
import { dungeons } from "../dungeons/registry.ts";
import { ApiError } from "./api.ts";
import { autopilotPicker } from "./autopilot.ts";
import { h, icon } from "./dom.ts";
import type { Store } from "./store.ts";

export interface ConfigActions {
  save(patch: ConfigPatch): Promise<void>;
  navigate(route: "start"): void;
}

type Section = "defaults" | "nuclis" | "typesafe";

function section(
  store: Store,
  id: Section,
  title: string,
  ...children: (HTMLElement | null)[]
): HTMLElement {
  const notice = store.get().configNotice;
  const mine = notice?.section === id ? notice : undefined;
  return h(
    "section",
    {},
    h("h2", {}, title),
    ...children,
    h(
      "p",
      {
        class: `save-status${mine?.error ? " error-text" : ""}`,
        role: "status",
      },
      mine?.text ?? "",
    ),
  );
}

export function configPage(store: Store, actions: ConfigActions): HTMLElement {
  const { config, deciders, configError } = store.get();
  const back = h(
    "a",
    {
      href: "/",
      class: "icon-link",
      "aria-label": "Back",
      title: "Back",
      onclick: (event: Event) => {
        event.preventDefault();
        actions.navigate("start");
      },
    },
    icon(ArrowLeft),
  );
  const head = h(
    "header",
    { class: "card-head" },
    h(
      "div",
      {},
      h("h1", {}, "Config"),
      h(
        "p",
        {},
        config
          ? `Stored in ${config.home}/config.json (mode 600). Environment variables override it.`
          : (configError ?? "Loading…"),
      ),
    ),
    back,
  );
  if (!config || !deciders)
    return h(
      "main",
      { class: "page" },
      h("div", { class: "card glass" }, head),
    );

  const say = (section: Section, text: string, error = false) =>
    store.set({ configNotice: { section, text, error } });
  const run = async (section: Section, patch: ConfigPatch, done: string) => {
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

  // Autopilot defaults.
  const defaults = section(
    store,
    "defaults",
    "Autopilot defaults",
    ...Object.values(dungeons).map((dungeon) =>
      h(
        "div",
        { class: "default-row" },
        h("h3", {}, dungeon.title),
        autopilotPicker(
          deciders,
          config.autopilot[dungeon.id],
          (choice) =>
            void run(
              "defaults",
              { autopilot: { [dungeon.id]: choice } },
              `${dungeon.title} starts with ${choice.decider} · ${choice.model}.`,
            ),
          `default-${dungeon.id}`,
        ),
      ),
    ),
  );

  // nuclis.
  const nuclisView = deciders.find((d) => d.id === "nuclis");
  const fromEnv = config.nuclis.binSource === "env";
  const bin = h("input", {
    type: "text",
    name: "nuclis-bin",
    value: config.nuclis.bin,
    spellcheck: "false",
    autocomplete: "off",
    disabled: fromEnv,
  });
  const backend = h(
    "select",
    { name: "nuclis-backend" },
    h("option", { value: "" }, "nuclis default"),
    h("option", { value: "metal" }, "metal"),
    h("option", { value: "cpu" }, "cpu"),
  );
  backend.value = config.nuclis.backend ?? "";
  const nuclis = section(
    store,
    "nuclis",
    "nuclis",
    h(
      "p",
      {},
      nuclisView?.status.configured
        ? (nuclisView.status.version ?? "found")
        : (nuclisView?.status.reason ?? "not found"),
      nuclisView?.status.reachable === false && nuclisView.status.reason
        ? ` — ${nuclisView.status.reason}`
        : "",
    ),
    h(
      "label",
      { class: "field" },
      h("span", {}, "Binary"),
      bin,
      h(
        "small",
        {},
        fromEnv
          ? "Set by NUCLIS_BIN; unset it to change this here."
          : "An absolute path, or a command on the server's PATH.",
      ),
    ),
    h("label", { class: "field" }, h("span", {}, "Backend"), backend),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          type: "button",
          onclick: () => {
            const patch: ConfigPatch = {
              nuclis: {
                backend: (backend.value || null) as Backend | null,
                ...(fromEnv
                  ? {}
                  : {
                      bin:
                        bin.value.trim() === "nuclis" ? null : bin.value.trim(),
                    }),
              },
            };
            void run("nuclis", patch, "Saved.");
          },
        },
        "Save",
      ),
    ),
  );

  // TypeSafe.
  const key = h("input", {
    type: "password",
    name: "typesafe-key",
    placeholder: config.typesafe.keySet ? "Replace the key" : "Paste a key",
    autocomplete: "off",
    spellcheck: "false",
  });
  const typesafe = section(
    store,
    "typesafe",
    "TypeSafe Jev",
    h(
      "p",
      {},
      config.typesafe.keySet
        ? config.typesafe.keySource === "env"
          ? "A key is set by TYPESAFE_API_KEY, which overrides the file."
          : "A key is set. The server keeps it; this page cannot read it back."
        : "No key. Jev is unavailable until one is set.",
    ),
    h("label", { class: "field" }, h("span", {}, "API key"), key),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          type: "button",
          onclick: () => {
            const value = key.value.trim();
            if (!value) return say("typesafe", "Paste a key first.", true);
            key.value = "";
            void run("typesafe", { typesafe: { apiKey: value } }, "Key saved.");
          },
        },
        "Save key",
      ),
      config.typesafe.keySource === "file"
        ? h(
            "button",
            {
              type: "button",
              class: "danger",
              onclick: () =>
                void run(
                  "typesafe",
                  { typesafe: { apiKey: null } },
                  "Key removed.",
                ),
            },
            "Remove key",
          )
        : null,
    ),
  );

  return h(
    "main",
    { class: "page" },
    h("div", { class: "card glass config" }, head, defaults, nuclis, typesafe),
  );
}
