/** The brand package ships SVG; Vite hands an import of one back as a URL. */
declare module "*.svg" {
  const url: string;
  export default url;
}
