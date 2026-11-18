/**
 * Client feature switches. Flip a value here to turn a rider-facing feature on or off;
 * the code behind a disabled feature stays in place.
 *
 * Mutable on purpose: tests flip it per-case (src/test-setup.ts enables everything).
 */
export const FEATURES = {
  /**
   * Shared (pooled) rides. Off until the product relaunches them: the ride-type
   * toggle is hidden and every booking is private.
   */
  sharedRides: false,
};
