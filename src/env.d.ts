/// <reference types="vite/client" />

declare module "papaparse/papaparse.min.js" {
  import Papa from "papaparse";

  export default Papa;
}

declare module "*.html" {
  const value: import("bun").HTMLBundle;
  export default value;
}

declare const RECRUITAI_PACKAGED: boolean;
