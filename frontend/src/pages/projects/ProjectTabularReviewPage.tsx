import { useParams } from 'react-router-dom';
import { TRView } from '@/app/components/tabular/TabularReviewView';

export default function ProjectTabularReviewPage() {
  const { id, reviewId } = useParams<{ id: string; reviewId: string }>();
  return <TRView reviewId={reviewId!} projectId={id!} />;
}
