"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    signUp,
    confirmSignUp,
    signIn,
    setUpTOTP,
    verifyTOTPSetup,
    updateMFAPreference,
} from "@/lib/aws/amplify-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { SiteLogo } from "@/components/site-logo";
import { CheckCircle2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

type Step = "form" | "confirm" | "totp" | "done";

export default function SignupPage() {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const [step, setStep] = useState<Step>("form");

    // Form fields
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [firstName, setFirstName] = useState("");
    const [lastName, setLastName] = useState("");

    // Confirmation / TOTP
    const [confirmCode, setConfirmCode] = useState("");
    const [totpUri, setTotpUri] = useState("");
    const [totpCode, setTotpCode] = useState("");

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!authLoading && isAuthenticated && step !== "done") {
            router.replace("/assistant");
        }
    }, [authLoading, isAuthenticated, router, step]);

    const handleSignup = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);

        if (password !== confirmPassword) {
            setError("Passwords do not match");
            return;
        }
        if (password.length < 8) {
            setError("Password must be at least 8 characters");
            return;
        }

        setLoading(true);
        try {
            const result = await signUp({
                username: email,
                password,
                options: {
                    userAttributes: {
                        email,
                        given_name: firstName.trim(),
                        family_name: lastName.trim(),
                    },
                },
            });
            if (result.nextStep.signUpStep === "CONFIRM_SIGN_UP") {
                setStep("confirm");
            } else if (result.isSignUpComplete) {
                await handlePostConfirm();
            }
        } catch (err: any) {
            setError(err.message || "An error occurred during signup");
        } finally {
            setLoading(false);
        }
    };

    const handleConfirm = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setLoading(true);
        try {
            await confirmSignUp(email, confirmCode);
            await handlePostConfirm();
        } catch (err: any) {
            setError(err.message || "Confirmation failed");
        } finally {
            setLoading(false);
        }
    };

    const handlePostConfirm = async () => {
        // Sign in to get a session, then set up TOTP MFA
        const result = await signIn(email, password);
        if (result.isSignedIn) {
            await initTotpSetup();
        } else if (result.nextStep.signInStep === "CONTINUE_SIGN_IN_WITH_TOTP_SETUP") {
            // Cognito started TOTP setup in the flow — extract URI from nextStep
            const uri = (result.nextStep as any).totpSetupDetails?.getSetupUri?.("Louis")?.toString() ?? "";
            setTotpUri(uri);
            setStep("totp");
        }
    };

    const initTotpSetup = async () => {
        const totpOutput = await setUpTOTP();
        const uri = totpOutput.getSetupUri("Louis").toString();
        setTotpUri(uri);
        setStep("totp");
    };

    const handleTotpVerify = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setLoading(true);
        try {
            await verifyTOTPSetup({ code: totpCode });
            await updateMFAPreference({ totp: "PREFERRED" });
            setStep("done");
            setTimeout(() => router.push("/assistant"), 1500);
        } catch (err: any) {
            setError(err.message || "TOTP verification failed");
        } finally {
            setLoading(false);
        }
    };

    if (step === "done") {
        return (
            <div className="min-h-dvh bg-white flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
                <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                    <SiteLogo size="md" className="md:text-4xl" asLink />
                </div>
                <div className="w-full max-w-md">
                    <div className="bg-white border border-gray-200 rounded-2xl p-10 text-center shadow-sm">
                        <div className="mx-auto w-12 h-12 bg-green-50 rounded-full flex items-center justify-center mb-6">
                            <CheckCircle2 className="h-6 w-6 text-green-600" />
                        </div>
                        <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                            Account created!
                        </h2>
                        <p className="text-gray-600 leading-relaxed">
                            Redirecting you to the home page...
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    if (step === "totp") {
        return (
            <div className="min-h-dvh bg-white flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
                <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                    <SiteLogo size="md" className="md:text-4xl" asLink />
                </div>
                <div className="w-full max-w-md">
                    <div className="bg-white border border-gray-200 rounded-2xl p-8">
                        <h2 className="text-2xl font-serif mb-2">
                            Set up authenticator
                        </h2>
                        <p className="text-sm text-gray-500 mb-4">
                            Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.), then enter the 6-digit code to verify.
                        </p>
                        {totpUri && (
                            <div className="flex justify-center mb-4">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                    src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(totpUri)}`}
                                    alt="TOTP QR code"
                                    width={180}
                                    height={180}
                                    className="rounded"
                                />
                            </div>
                        )}
                        <form onSubmit={handleTotpVerify} className="space-y-4">
                            <Input
                                type="text"
                                inputMode="numeric"
                                value={totpCode}
                                onChange={(e) => setTotpCode(e.target.value)}
                                placeholder="6-digit code"
                                maxLength={6}
                                required
                                className="w-full"
                            />
                            {error && (
                                <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                    {error}
                                </div>
                            )}
                            <Button
                                type="submit"
                                disabled={loading}
                                className="w-full bg-black hover:bg-gray-900 text-white"
                            >
                                {loading ? "Verifying..." : "Verify & continue"}
                            </Button>
                        </form>
                    </div>
                </div>
            </div>
        );
    }

    if (step === "confirm") {
        return (
            <div className="min-h-dvh bg-white flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
                <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                    <SiteLogo size="md" className="md:text-4xl" asLink />
                </div>
                <div className="w-full max-w-md">
                    <div className="bg-white border border-gray-200 rounded-2xl p-8">
                        <h2 className="text-2xl font-serif mb-2">
                            Check your email
                        </h2>
                        <p className="text-sm text-gray-500 mb-6">
                            We sent a verification code to{" "}
                            <strong>{email}</strong>. Enter it below.
                        </p>
                        <form onSubmit={handleConfirm} className="space-y-4">
                            <Input
                                type="text"
                                value={confirmCode}
                                onChange={(e) => setConfirmCode(e.target.value)}
                                placeholder="Verification code"
                                required
                                className="w-full"
                            />
                            {error && (
                                <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                    {error}
                                </div>
                            )}
                            <Button
                                type="submit"
                                disabled={loading}
                                className="w-full bg-black hover:bg-gray-900 text-white"
                            >
                                {loading ? "Verifying..." : "Verify"}
                            </Button>
                        </form>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-dvh bg-white flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="md" className="md:text-4xl" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className="bg-white border border-gray-200 rounded-2xl p-8">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-left text-2xl font-serif">
                            Create Account
                        </h2>
                        <div className="bg-gray-100 p-1 rounded-md flex text-xs font-medium">
                            <Link
                                href="/login"
                                className="px-3 py-1 text-gray-500 hover:text-gray-900"
                            >
                                Log in
                            </Link>
                            <span className="px-3 py-1 bg-white rounded-sm shadow-sm text-gray-900">
                                Sign up
                            </span>
                        </div>
                    </div>

                    <form onSubmit={handleSignup} className="space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label
                                    htmlFor="firstName"
                                    className="block text-sm font-medium text-gray-700 mb-2"
                                >
                                    First name
                                </label>
                                <Input
                                    id="firstName"
                                    type="text"
                                    value={firstName}
                                    onChange={(e) => setFirstName(e.target.value)}
                                    placeholder="First name"
                                    required
                                    className="w-full"
                                />
                            </div>
                            <div>
                                <label
                                    htmlFor="lastName"
                                    className="block text-sm font-medium text-gray-700 mb-2"
                                >
                                    Last name
                                </label>
                                <Input
                                    id="lastName"
                                    type="text"
                                    value={lastName}
                                    onChange={(e) => setLastName(e.target.value)}
                                    placeholder="Last name"
                                    required
                                    className="w-full"
                                />
                            </div>
                        </div>

                        <div>
                            <label
                                htmlFor="email"
                                className="block text-sm font-medium text-gray-700 mb-2"
                            >
                                Email
                            </label>
                            <Input
                                id="email"
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="Enter your email"
                                required
                                className="w-full"
                            />
                        </div>

                        <div>
                            <label
                                htmlFor="password"
                                className="block text-sm font-medium text-gray-700 mb-2"
                            >
                                Password
                            </label>
                            <Input
                                id="password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Min. 8 chars, upper, lower, number, symbol"
                                required
                                className="w-full"
                            />
                        </div>

                        <div>
                            <label
                                htmlFor="confirmPassword"
                                className="block text-sm font-medium text-gray-700 mb-2"
                            >
                                Confirm Password
                            </label>
                            <Input
                                id="confirmPassword"
                                type="password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                placeholder="Confirm your password"
                                required
                                className="w-full"
                            />
                        </div>

                        {error && (
                            <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                {error}
                            </div>
                        )}

                        <Button
                            type="submit"
                            disabled={loading}
                            className="w-full bg-black hover:bg-gray-900 text-white"
                        >
                            {loading ? "Creating account..." : "Sign up"}
                        </Button>
                    </form>

                    <div className="mt-4 text-center text-xs text-gray-500">
                        By signing up, you agree to our{" "}
                        <Link
                            href="https://mikeoss.com/terms"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline"
                        >
                            Terms of Use
                        </Link>{" "}
                        and{" "}
                        <Link
                            href="https://mikeoss.com/privacy"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline"
                        >
                            Privacy Policy
                        </Link>
                    </div>
                </div>
            </div>
        </div>
    );
}
