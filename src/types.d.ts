declare global {
    namespace ioBroker {
        interface AdapterConfig {
            apiKey: string;
            deviceName: string;
            streamPort: number;
            streamHost: string;
            apiPort: number;
            format: 'mp3' | 'flac';
            targets: { id: string; enabled?: boolean }[];
            stopAfterSec: number;
        }
    }
}

export {};
