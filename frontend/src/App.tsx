import { Amplify } from 'aws-amplify';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { SiteLogo } from './components/site-logo';
import { amplifyConfig } from './lib/aws/config';
import { AuthProvider } from './contexts/AuthContext';
import { UserProfileProvider } from './contexts/UserProfileContext';
import { AwsProvider } from './contexts/AwsContext';
import AppLayout from './components/AppLayout';
import AssistantPage from './pages/assistant/AssistantPage';
import AssistantChatPageWrapper from './pages/assistant/AssistantChatPage';
import ProjectsPage from './pages/projects/ProjectsPage';
import ProjectPage from './pages/projects/ProjectPage';
import ProjectChatPage from './pages/projects/ProjectChatPage';
import TabularReviewsPage from './pages/tabular-reviews/TabularReviewsPage';
import TabularReviewPage from './pages/tabular-reviews/TabularReviewPage';
import ProjectTabularReviewPage from './pages/projects/ProjectTabularReviewPage';
import WorkflowsPage from './pages/workflows/WorkflowsPage';
import WorkflowPage from './pages/workflows/WorkflowPage';
import AccountPage from './pages/account/AccountPage';
import AccountModelsPage from './pages/account/AccountModelsPage';

// Configure Amplify once at app startup — single source of truth
Amplify.configure(amplifyConfig);

export default function App() {
  return (
    <Authenticator
      loginMechanisms={['email']}
      signUpAttributes={['given_name', 'family_name', 'email']}
      formFields={{
        signUp: {
          email: { order: 1 },
          given_name: { order: 2 },
          family_name: { order: 3 },
          'custom:organisation': {
            label: 'Organisation',
            placeholder: 'Your organisation',
            isRequired: false,
            order: 4,
          },
          password: { order: 5 },
          confirm_password: { order: 6 },
        },
      }}
      components={{
        Header() {
          return (
            <div className="flex justify-center pt-10 pb-8">
              <SiteLogo size="lg" />
            </div>
          );
        },
      }}
    >
      {() => (
        <AwsProvider>
          <AuthProvider>
            <UserProfileProvider>
              <BrowserRouter>
                <Routes>
                  <Route path="/" element={<Navigate to="/assistant" replace />} />
                  <Route element={<AppLayout />}>
                    <Route path="/assistant" element={<AssistantPage />} />
                    <Route
                      path="/assistant/chat/:id"
                      element={<AssistantChatPageWrapper />}
                    />
                    <Route path="/projects" element={<ProjectsPage />} />
                    <Route path="/projects/:id" element={<ProjectPage />} />
                    <Route
                      path="/projects/:id/assistant/chat/:chatId"
                      element={<ProjectChatPage />}
                    />
                    <Route
                      path="/projects/:id/tabular-reviews/:reviewId"
                      element={<ProjectTabularReviewPage />}
                    />
                    <Route path="/tabular-reviews" element={<TabularReviewsPage />} />
                    <Route path="/tabular-reviews/:id" element={<TabularReviewPage />} />
                    <Route path="/workflows" element={<WorkflowsPage />} />
                    <Route path="/workflows/:id" element={<WorkflowPage />} />
                    <Route path="/account" element={<AccountPage />}>
                      <Route path="models" element={<AccountModelsPage />} />
                    </Route>
                  </Route>
                  <Route path="*" element={<Navigate to="/assistant" replace />} />
                </Routes>
              </BrowserRouter>
            </UserProfileProvider>
          </AuthProvider>
        </AwsProvider>
      )}
    </Authenticator>
  );
}
