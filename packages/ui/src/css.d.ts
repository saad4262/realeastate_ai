/**
 * CSS modules, for a package compiled by the apps rather than by tsc.
 *
 * Next provides this through next-env.d.ts inside an app; a package that ships
 * source needs to say it itself or `tsc --noEmit` cannot see the import.
 */
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
