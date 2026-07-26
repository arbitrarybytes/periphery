'use strict';

/**
 * Semantic cue colours shared by the connectors, so "success green" is one
 * value instead of a literal re-typed (and drifting) per callsite. All values
 * pass utils/cuePayload.js isValidColor.
 */
module.exports = Object.freeze({
  /** Informational: review requests, mentions, direct mail. */
  INFO: 'rgba(0, 150, 255, 0.9)',
  /** Good news: pipeline passed, MR approved. */
  SUCCESS: 'rgba(0, 255, 100, 0.9)',
  /** Failures: broken pipeline, failed build. */
  DANGER: 'rgba(255, 0, 50, 0.9)',
  /** Barely-there grey for low-priority ambience (CC'd mail). */
  SUBTLE: 'rgba(100, 100, 100, 0.5)',
  /** Amber for app-level problems (expired credentials). */
  WARN: 'rgba(255, 176, 32, 0.8)',
  /** Orange for imminent meetings. */
  MEETING: 'rgba(255, 165, 0, 0.8)',
});
