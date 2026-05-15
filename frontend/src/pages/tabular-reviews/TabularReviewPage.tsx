import { useParams } from 'react-router-dom';
import { TRView } from '@/app/components/tabular/TabularReviewView';

export default function TabularReviewPage() {
  const { id } = useParams<{ id: string }>();
  return <TRView reviewId={id!} />;
}
