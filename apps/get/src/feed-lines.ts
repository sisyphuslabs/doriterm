/** The lines of an electron-updater `latest*.yml` that name a file, and the two the Worker adds itself. */
export const FILE_LINE = /^(\s*(?:- )?(?:url|path): )(.*)$/;
export const ADDED_LINE = /^(?:stagingPercentage|minimumVersion):/;
