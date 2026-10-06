import { ReviewsScreen } from '@/components/reviews/reviews-screen';

/** The agency's Google reviews, for an agent (docs/adr/0028): the agency's, labelled as such. */
export default function Page() {
  return <ReviewsScreen surface="agent" />;
}
