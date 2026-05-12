import { useState, useEffect } from 'react';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LogOut, Check } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useUserProfile } from '@/contexts/UserProfileContext';
import { deleteAccount } from '@/app/lib/mikeApi';

const TABS = [
  { id: 'general', label: 'General', href: '/account' },
  { id: 'models', label: 'Models', href: '/account/models' },
];

export default function AccountPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, signOut } = useAuth();
  const { profile, updateDisplayName, updateOrganisation } = useUserProfile();
  const [displayName, setDisplayName] = useState('');
  const [isSavingName, setIsSavingName] = useState(false);
  const [saved, setSaved] = useState(false);
  const [organisation, setOrganisation] = useState('');
  const [isSavingOrg, setIsSavingOrg] = useState(false);
  const [orgSaved, setOrgSaved] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (profile?.displayName) setDisplayName(profile.displayName);
    if (profile?.organisation) setOrganisation(profile.organisation);
  }, [profile]);

  const handleLogout = async () => {
    await signOut();
    navigate('/');
  };

  const handleDeleteAccount = async () => {
    setIsDeleting(true);
    try {
      await deleteAccount();
      await signOut();
      navigate('/');
    } catch {
      setIsDeleting(false);
      setDeleteConfirm(false);
      alert('Failed to delete account. Please try again.');
    }
  };

  const handleSaveDisplayName = async () => {
    setIsSavingName(true);
    const success = await updateDisplayName(displayName.trim());
    setIsSavingName(false);
    if (success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      alert('Failed to update display name. Please try again.');
    }
  };

  const handleSaveOrganisation = async () => {
    setIsSavingOrg(true);
    const success = await updateOrganisation(organisation.trim());
    setIsSavingOrg(false);
    if (success) {
      setOrgSaved(true);
      setTimeout(() => setOrgSaved(false), 2000);
    } else {
      alert('Failed to update organisation. Please try again.');
    }
  };

  if (!user) return null;

  const isModelsTab = location.pathname === '/account/models';

  return (
    <div className="flex flex-col h-full md:overflow-y-auto px-6 py-6 md:py-10">
      <div className="max-w-5xl w-full mx-auto">
        <h1 className="text-4xl font-medium mb-8 font-eb-garamond">Settings</h1>
        <div className="flex flex-col md:flex-row gap-6 md:gap-10">
          <nav aria-label="Settings" className="md:w-56 shrink-0 flex md:flex-col gap-1 overflow-x-auto">
            {TABS.map((tab) => {
              const active = location.pathname === tab.href;
              return (
                <button
                  key={tab.id}
                  onClick={() => navigate(tab.href)}
                  className={`text-left whitespace-nowrap px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    active
                      ? 'bg-gray-100 text-gray-900'
                      : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>

          <div className="flex-1 min-w-0">
            {isModelsTab ? (
              <Outlet />
            ) : (
              <div className="space-y-4">
                <div className="pb-6">
                  <h2 className="text-2xl font-medium font-serif mb-4">Profile</h2>
                  <div className="space-y-4">
                    <div>
                      <label className="text-sm text-gray-600 block mb-2">Display Name</label>
                      <div className="flex gap-2">
                        <Input
                          type="text"
                          value={displayName}
                          onChange={(e) => setDisplayName(e.target.value)}
                          placeholder="Enter your name"
                          className="flex-1"
                        />
                        <Button
                          onClick={handleSaveDisplayName}
                          disabled={isSavingName || !displayName.trim() || saved}
                          className="min-w-[80px] transition-all bg-black hover:bg-gray-900 text-white"
                        >
                          {isSavingName ? 'Saving...' : saved ? <><Check className="h-4 w-3" />Saved</> : 'Save'}
                        </Button>
                      </div>
                    </div>
                    <div>
                      <label className="text-sm text-gray-600 block mb-2">Organisation</label>
                      <div className="flex gap-2">
                        <Input
                          type="text"
                          value={organisation}
                          onChange={(e) => setOrganisation(e.target.value)}
                          placeholder="Enter your organisation"
                          className="flex-1"
                        />
                        <Button
                          onClick={handleSaveOrganisation}
                          disabled={isSavingOrg || organisation.trim() === (profile?.organisation ?? '') || orgSaved}
                          className="min-w-[80px] transition-all bg-black hover:bg-gray-900 text-white"
                        >
                          {isSavingOrg ? 'Saving...' : orgSaved ? <><Check className="h-4 w-3" />Saved</> : 'Save'}
                        </Button>
                      </div>
                    </div>
                    <div>
                      <label className="text-sm text-gray-600 block mb-2">Email</label>
                      <p className="text-base">{user?.email}</p>
                    </div>
                  </div>
                </div>

                <div className="py-6">
                  <h2 className="text-2xl font-medium font-serif mb-4">Usage Plan</h2>
                  <p className="text-base font-medium text-gray-500 capitalize">{profile?.tier ? `${profile.tier} Tier` : "Free Tier"}</p>
                </div>

                <div className="py-6">
                  <h2 className="text-2xl font-medium font-serif mb-4">Actions</h2>
                  <Button variant="outline" onClick={handleLogout} className="w-full sm:w-auto">
                    <LogOut className="h-4 w-4 mr-2" />
                    Sign Out
                  </Button>
                </div>

                <div className="py-6">
                  <h2 className="text-2xl font-medium font-serif mb-1 text-red-600">Danger Zone</h2>
                  <p className="text-sm text-gray-500 mb-4">
                    Permanently delete your account and all associated data. This action cannot be undone.
                  </p>
                  {deleteConfirm ? (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-3 max-w-sm">
                      <p className="text-sm font-medium text-red-700">
                        Are you sure? This will permanently delete your account.
                      </p>
                      <div className="flex gap-2">
                        <Button variant="outline" onClick={() => setDeleteConfirm(false)} disabled={isDeleting} className="text-sm">
                          Cancel
                        </Button>
                        <Button onClick={handleDeleteAccount} disabled={isDeleting} className="text-sm bg-red-600 hover:bg-red-700 text-white">
                          {isDeleting ? 'Deleting…' : 'Delete Account'}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={() => setDeleteConfirm(true)}
                      className="w-full sm:w-auto border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                    >
                      Delete Account
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
