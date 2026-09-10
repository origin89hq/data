/**
 * The brand package ships CSS and SVG; wrangler is configured to hand them over as text. Without
 * this the imports are an error at type-check even though they work at runtime.
 */
declare module "*.css" {
  const contents: string;
  export default contents;
}
declare module "*.svg" {
  const contents: string;
  export default contents;
}
