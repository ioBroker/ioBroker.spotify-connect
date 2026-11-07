declare global {
    namespace ioBroker {
        interface AdapterConfig {
            soloistPath: string;
            apiKey: string;
            deviceName: string;
            streamPort: number;
            format: 'mp3' | 'flac';
            targets: { id: string }[];
            stopAfterSec: number;
        }
    }
}

export {};
