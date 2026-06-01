import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:driver_app/features/rating/rating_provider.dart';

class _FakeRatingService implements RatingService {
  _FakeRatingService({this.error});

  final Object? error;
  final List<({String rideId, int stars, String? text})> calls = [];

  @override
  Future<void> submit(String rideId, int stars, String? text) async {
    calls.add((rideId: rideId, stars: stars, text: text));
    if (error != null) throw error!;
  }
}

class _MockDio extends Mock implements Dio {}

void main() {
  group('RatingNotifier', () {
    test('setStars records the chosen rating', () {
      final n = RatingNotifier(_FakeRatingService(), 'r-1');
      expect(n.state.stars, 0);
      expect(n.state.canSubmit, isFalse);
      n.setStars(4);
      expect(n.state.stars, 4);
      expect(n.state.canSubmit, isTrue);
    });

    test('submit posts stars + text and latches submitted', () async {
      final svc = _FakeRatingService();
      final n = RatingNotifier(svc, 'r-1')..setStars(5);
      await n.submit('great ride');
      expect(svc.calls.single, (rideId: 'r-1', stars: 5, text: 'great ride'));
      expect(n.state.submitted, isTrue);
      expect(n.state.busy, isFalse);
    });

    test('submit is a no-op until a star is chosen', () async {
      final svc = _FakeRatingService();
      final n = RatingNotifier(svc, 'r-1');
      await n.submit('no stars yet');
      expect(svc.calls, isEmpty);
      expect(n.state.submitted, isFalse);
    });

    test('submit failure drops busy and stays un-submitted (retryable)', () async {
      final svc = _FakeRatingService(error: Exception('network'));
      final n = RatingNotifier(svc, 'r-1')..setStars(3);
      await n.submit(null);
      expect(svc.calls.length, 1);
      expect(n.state.busy, isFalse);
      expect(n.state.submitted, isFalse);
      // The driver can change stars and retry.
      n.setStars(4);
      expect(n.state.stars, 4);
    });
  });

  group('HttpRatingService', () {
    late _MockDio dio;
    late HttpRatingService svc;

    setUp(() {
      dio = _MockDio();
      svc = HttpRatingService(dio);
    });

    test('POSTs stars + text to the ratings endpoint', () async {
      when(() => dio.post<Map<String, dynamic>>(any(), data: any(named: 'data'))).thenAnswer(
        (_) async => Response(
          requestOptions: RequestOptions(path: '/'),
          statusCode: 201,
          data: {'id': 'x'},
        ),
      );

      await svc.submit('r-1', 5, 'great');

      final captured = verify(
        () => dio.post<Map<String, dynamic>>(captureAny(), data: captureAny(named: 'data')),
      ).captured;
      expect(captured[0], '/v1/rides/r-1/ratings');
      expect(captured[1], {'stars': 5, 'text': 'great'});
    });

    test('omits empty / null text', () async {
      when(() => dio.post<Map<String, dynamic>>(any(), data: any(named: 'data'))).thenAnswer(
        (_) async => Response(requestOptions: RequestOptions(path: '/'), statusCode: 201),
      );

      await svc.submit('r-1', 4, null);

      final data = verify(
        () => dio.post<Map<String, dynamic>>(any(), data: captureAny(named: 'data')),
      ).captured.single;
      expect(data, {'stars': 4});
    });

    test('swallows a 409 already_rated (treated as done)', () async {
      when(() => dio.post<Map<String, dynamic>>(any(), data: any(named: 'data'))).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: '/'),
          response: Response(requestOptions: RequestOptions(path: '/'), statusCode: 409),
        ),
      );

      await expectLater(svc.submit('r-1', 5, null), completes);
    });

    test('rethrows a non-409 error', () async {
      when(() => dio.post<Map<String, dynamic>>(any(), data: any(named: 'data'))).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: '/'),
          response: Response(requestOptions: RequestOptions(path: '/'), statusCode: 500),
        ),
      );

      await expectLater(svc.submit('r-1', 5, null), throwsA(isA<DioException>()));
    });
  });
}
