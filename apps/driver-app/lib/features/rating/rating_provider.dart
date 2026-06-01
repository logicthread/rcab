import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../di/providers.dart';

/// Transport seam for rating submission so the notifier runs without a real Dio
/// in tests. RCAB-E4.S9.
abstract class RatingService {
  /// Submit a rating for [rideId]. Resolves on success; a repeat submission
  /// (HTTP 409 `already_rated`) is swallowed as success — the ride is already
  /// rated. Any other error propagates so the screen can offer a retry.
  Future<void> submit(String rideId, int stars, String? text);
}

class HttpRatingService implements RatingService {
  HttpRatingService(this._dio);

  final Dio _dio;

  @override
  Future<void> submit(String rideId, int stars, String? text) async {
    try {
      await _dio.post<Map<String, dynamic>>(
        '/v1/rides/$rideId/ratings',
        data: {'stars': stars, if (text != null && text.isNotEmpty) 'text': text},
      );
    } on DioException catch (e) {
      // A repeat submission is a no-op success: the ride is already rated.
      if (e.response?.statusCode == 409) return;
      rethrow;
    }
  }
}

/// Prompt state: the chosen star count (0 = none yet), an in-flight flag, and a
/// `submitted` latch that drives the screen home once the rating is recorded.
class RatingState {
  const RatingState({this.stars = 0, this.busy = false, this.submitted = false});

  final int stars;
  final bool busy;
  final bool submitted;

  /// Submit is allowed once a star is chosen and nothing is in flight / done.
  bool get canSubmit => stars >= 1 && !busy && !submitted;

  RatingState copyWith({int? stars, bool? busy, bool? submitted}) => RatingState(
        stars: stars ?? this.stars,
        busy: busy ?? this.busy,
        submitted: submitted ?? this.submitted,
      );
}

class RatingNotifier extends StateNotifier<RatingState> {
  RatingNotifier(this._service, this._rideId) : super(const RatingState());

  final RatingService _service;
  final String _rideId;

  void setStars(int stars) {
    if (state.busy || state.submitted) return;
    state = state.copyWith(stars: stars);
  }

  /// Persist the rating. On success the `submitted` latch flips (screen routes
  /// home). On failure we simply drop `busy` so the driver can retry.
  Future<void> submit(String? text) async {
    if (!state.canSubmit) return;
    state = state.copyWith(busy: true);
    try {
      await _service.submit(_rideId, state.stars, text);
      state = state.copyWith(busy: false, submitted: true);
    } catch (_) {
      state = state.copyWith(busy: false);
    }
  }
}

final ratingServiceProvider = Provider<RatingService>(
  (ref) => HttpRatingService(ref.watch(apiClientProvider)),
);

final ratingProvider =
    StateNotifierProvider.autoDispose.family<RatingNotifier, RatingState, String>(
  (ref, rideId) => RatingNotifier(ref.watch(ratingServiceProvider), rideId),
);
