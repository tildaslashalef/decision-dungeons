// SVG files imported as text (`with { type: "text" }`); see src/ui/icons.ts.
declare module "*.svg" {
  const text: string;
  export default text;
}
