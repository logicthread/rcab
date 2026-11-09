/// Driver-app client policy knobs (RCAB-E8.S10): every client-side timing /
/// cadence decision of the driver app in ONE annotated const block.
///
/// Server-owned values come from the server where it sends them (the offer
/// countdown uses the offer's `ttlMs`; the fallback below is only for a
/// payload without it). Values marked `server-mirror` copy a server rule the
/// app cannot read at runtime; keep them in step with
/// `apps/api/src/config/policy/policy.schema.ts`.
///
/// `docs/POLICY.md` is generated from this file (`pnpm policy:doc`): every
/// `static const` needs a description line and a
/// `unit: … | source: client|server-mirror | decision: …` line, or the
/// generator fails.
class DriverPolicy {
  DriverPolicy._();

  /// Offer countdown fallback when an offer payload has no ttlMs (the server always sends dispatch.offerTtlMs).
  /// unit: ms | source: server-mirror | decision: features-top-k-dispatch offer TTL 12 s.
  static const int offerTtlFallbackMs = 12000;

  /// Granularity of the offer / shared-offer countdown ticker.
  /// unit: duration | source: client | decision: RCAB-E4.S5 driver offer screen (1 s tick).
  static const Duration offerCountdownTick = Duration(seconds: 1);

  /// How long a shared-ride accept waits for its ack before asking the server for a snapshot.
  /// unit: duration | source: client | decision: Stage-C driver-app fix (undecided accept ack) 8 s.
  static const Duration sharedAcceptAckTimeout = Duration(seconds: 8);

  /// After arrival, how long before the no-show button unlocks (the server re-validates).
  /// unit: duration | source: server-mirror | decision: RCAB-E4.S8 rides.noShowWaitMs 5 min.
  static const Duration noShowWait = Duration(minutes: 5);

  /// Foreground location task cadence (one-shot fix every interval while online).
  /// unit: ms | source: client | decision: RCAB-E3.S4 foreground service 5 s.
  static const int locationIntervalMs = 5000;

  /// Minimum movement before a new location fix is sent to the server.
  /// unit: m | source: client | decision: RCAB-E3.S5 location streaming 10 m.
  static const double locationMinMoveMeters = 10.0;

  /// Send / receive timeout of the best-effort logout call.
  /// unit: duration | source: client | decision: RCAB-E8.S7 native logout 5 s.
  static const Duration logoutTimeout = Duration(seconds: 5);

  /// Firebase phone-verification auto-retrieval timeout.
  /// unit: duration | source: client | decision: RCAB-E3.S2 Firebase OTP 60 s.
  static const Duration otpAutoRetrievalTimeout = Duration(seconds: 60);

  /// Show the OEM service-kill banner if the OS killed the service within this window.
  /// unit: ms | source: client | decision: RCAB-E3.S6 OEM-kill mitigation 24 h.
  static const int serviceKillBannerWindowMs = 86400000;
}
