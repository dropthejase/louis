"use client";

export default function ModelsPage() {
    return (
        <div className="space-y-4">
            <div className="pb-6">
                <div className="flex items-center gap-2 mb-4">
                    <h2 className="text-2xl font-medium font-serif">
                        Model Preferences
                    </h2>
                </div>
                <div className="space-y-4 max-w-md">
                    <p className="text-sm text-gray-600">
                        All AI features run on Amazon Bedrock. No API keys needed.
                    </p>
                </div>
            </div>
        </div>
    );
}
