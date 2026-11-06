// wrangler bundles *.yaml as Text modules (see [[rules]] in wrangler.toml).
declare module "*.yaml" {
  const text: string;
  export default text;
}
