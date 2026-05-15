import { useParams } from 'react-router-dom';
import { ProjectPage as ProjectPageComponent } from '@/app/components/projects/ProjectPage';

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  return <ProjectPageComponent projectId={id!} />;
}
