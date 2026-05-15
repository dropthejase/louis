import { useState, useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { ChatHistoryProvider } from '../app/contexts/ChatHistoryContext';
import { SidebarContext } from '../app/contexts/SidebarContext';
import { AppSidebar } from '../app/components/shared/AppSidebar';

// AppLayout wraps all authenticated pages with the sidebar shell.
// Auth guard is handled by Authenticator in App.tsx — no redirect needed here.
export default function AppLayout() {
  const navigate = useNavigate();

  const [isSidebarOpenDesktop, setIsSidebarOpenDesktop] = useState(() => {
    const saved = localStorage.getItem('sidebarOpen');
    return saved !== null ? saved === 'true' : true;
  });

  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    if (window.innerWidth < 768) return false;
    return isSidebarOpenDesktop;
  });

  useEffect(() => {
    if (window.innerWidth >= 768) {
      localStorage.setItem('sidebarOpen', isSidebarOpen.toString());
    }
  }, [isSidebarOpen]);

  useEffect(() => {
    const handleResize = () => {
      const isSmall = window.innerWidth < 768;
      if (isSmall && isSidebarOpen) setIsSidebarOpen(false);
      else if (!isSmall && !isSidebarOpen) setIsSidebarOpen(isSidebarOpenDesktop);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isSidebarOpen, isSidebarOpenDesktop]);

  const handleSidebarToggle = () => {
    if (window.innerWidth >= 768) {
      setIsSidebarOpenDesktop((v) => !v);
      setIsSidebarOpen((v) => !v);
    } else {
      setIsSidebarOpen((v) => !v);
    }
  };

  // suppress unused warning — navigate used in sidebar
  void navigate;

  return (
    <ChatHistoryProvider>
      <SidebarContext.Provider
        value={{
          setSidebarOpen: (open) => {
            setIsSidebarOpen(open);
            setIsSidebarOpenDesktop(open);
          },
        }}
      >
        <div className="h-dvh bg-white flex flex-col">
          <div className="flex-1 flex overflow-hidden">
            <AppSidebar isOpen={isSidebarOpen} onToggle={handleSidebarToggle} />
            <div className="flex-1 flex flex-col h-dvh md:overflow-hidden relative w-full">
              {/* Mobile header */}
              <div className="flex md:hidden items-center gap-3 px-4 py-3 border-b border-gray-100 shrink-0">
                <button
                  onClick={handleSidebarToggle}
                  className="flex items-center justify-center w-8 h-8 rounded hover:bg-gray-100 text-gray-500 transition-colors"
                >
                  <Menu className="h-5 w-5" />
                </button>
              </div>
              <main className="flex-1 overflow-y-auto md:overflow-hidden w-full h-full">
                <Outlet />
              </main>
            </div>
          </div>
        </div>
      </SidebarContext.Provider>
    </ChatHistoryProvider>
  );
}
