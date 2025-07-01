import { spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';

/**
 * When we convert audio for voice-to-text, use this bitrate, which is large enough to capture voice but small enough to be cheaper.
 */
const TARGET_VOICE_TO_TEXT_BITRATE = 22050

export type AudioSegmentSettings = {
    startSecs: number,  // Start time in seconds
    endSecs: number,    // End time in seconds
    toMono?: boolean,
    bitrateConversion?: number,  // Bitrate to convert to, e.g. 22050
    playbackSpeed?: number,  // Optional playback speed from `0.5` to `2`
}

/**
 * Utility to run a bash command without waiting for it to complete.
 */
function runBashWithoutWaiting(escapedBashString: string) {
    const child = spawn('bash', ['-c', escapedBashString], {
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
}

/**
 * Get information about an audio file, such as duration and bitrate.
 */
export function getAudioFileInfo(path: string): Promise<{
    duration: number;
    bit_rate: number;
}> {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(path, (err, metadata) => {
            if (err) {
                reject(err)
            } else {
                resolve({
                    duration: metadata.format.duration ?? 0,
                    bit_rate: metadata.format.bit_rate ?? 0,
                })
            }
        })
    })
}

/**
 * Extracts segment of audio from an audio file, given absolute start and end seconds, returning the path to the newly-created file.
 * Also sets the bitrate of the output file, and converts to mono.
 */
export function getAudioFileSegment(path: string, settings: AudioSegmentSettings): Promise<string> {
    return new Promise((resolve, reject) => {
        // Construct the segmented path
        const newPath = `${path}.segment-${settings.startSecs}-${settings.endSecs}.mp3`

        // Build the basic command
        let cmd = ffmpeg(path)
            .setStartTime(settings.startSecs)
            .setDuration(settings.endSecs - settings.startSecs)
            .noVideo()                  // in case we were given a video file

        // Convert to mono if specified
        if (settings.toMono) {
            cmd = cmd.audioChannels(1)  // set to mono
        }

        // Convert audio bitrate if specified
        if (settings.bitrateConversion) {
            cmd = cmd.audioBitrate(settings.bitrateConversion)  // set the bitrate
        }

        // Playback speed, if specified and not a trivial 1x, and clamped to 0.5-2
        const playbackSpeed = !settings.playbackSpeed ? 1 : settings.playbackSpeed < 0.5 ? 0.5 : settings.playbackSpeed > 2 ? 2 : settings.playbackSpeed;
        if (playbackSpeed != 1) {
            cmd = cmd.audioFilters(`atempo=${playbackSpeed}`)  // set the playback speed
        }

        // The rest of the command -- output and hooks
        cmd = cmd
            .output(newPath)
            .on('end', () => resolve(newPath))
            .on('error', (err) => reject(err));
        // Execute the command
        cmd.run()
    })
}

/**
 * Tells applications like Spotify and YouTube/Chrome to stop playing music.
 * Runs in background; does not wait for completion before continuing.  Executes quickly as a result, and does not return a `Promise`.
 */
export function stopPlayingMusic() {

    // Pause YouTube if Chrome is running
    const pauseYouTube = `
        tell application "Google Chrome"
        try
            with timeout of 2 seconds
                repeat with w in windows
                    repeat with t in tabs of w
                        try
                            if (URL of t contains "youtube.com") then
                                tell t to execute javascript "
                                    var player = document.querySelector(\\".html5-main-video\\");
                                    if (player && !player.paused) {
                                        player.pause();
                                    }
                                "
                            end if
                        on error errMsg
                        end try
                    end repeat
                end repeat
            end timeout
        on error timeoutErr
        end try
    end tell
    `
    runBashWithoutWaiting(`pgrep -q "Google Chrome" && osascript -e '${pauseYouTube}'`)

    // Pause Spotify if it is running
    runBashWithoutWaiting(`pgrep -q "Spotify" && osascript -e 'tell application "Spotify" to pause'`)
}

/**
 * Processes an audio file by splitting it into chunks, executing a function on each chunk.
 * The chunks will overlap with each other by overlapSecs.
 * There will always be at least one invocation.
 * Invocations are made sequentially, waiting for the callback to complete before proceeding.
 * 
 * @param fProcess The function to execute on each chunk.  `isTemporary` says whether this is a temporary chunk or the original file.
 * @returns An array of the paths to the chunks, e.g. for potential deletion / clean-up, or because you wanted to accumulate them.
 */
export async function processAudioFileInChunks(path: string, chunkSecs: number, overlapSecs: number, playbackSpeed: number, fProcess: (path: string, isTemporary: boolean) => Promise<void>): Promise<void> {

    // Get duration; if short enough, process as a single chunk and we're done, with no temporary files.
    const info = await getAudioFileInfo(path)
    if (info.duration <= chunkSecs + overlapSecs * 2) {
        await fProcess(path, false)
        return
    }

    // Split with overlap, processing each piece in turn.
    let startSecs = 0
    while (startSecs < info.duration) {
        const endSecs = Math.min(startSecs + chunkSecs, info.duration)
        const chunkPath = await getAudioFileSegment(path, {
            startSecs, endSecs,
            toMono: true,
            bitrateConversion: TARGET_VOICE_TO_TEXT_BITRATE,
            playbackSpeed,
        })   // create temporary chunk file
        await fProcess(chunkPath, true)
        startSecs += chunkSecs - overlapSecs
    }
}

/**
 * Streams the microphone input to an MP3 file on disk.
 */
export function recordMicrophone(outPath: string): {
    /**
     * A `Promise` that completes when the streaming has completed, resolving to the path on disk where the audio was saved.
     */
    completedPathPromise: Promise<string>,

    /**
     * Call this to stop recording from the microphone.
     */
    fStop: () => void
} {
    // Stop any music that might currently be playing
    stopPlayingMusic()

    // Start microphone -> file
    const mic = spawn('sox', ['-d', '-t', 'mp3', '-c', '1', '-r', TARGET_VOICE_TO_TEXT_BITRATE.toString(), outPath]);
    const fStop = () => { mic.kill() }
    mic.stderr.on('data', (data) => {
        console.log(`${data}`);
    });

    // When finished, resolve the promise
    let pathResolve: (path: string) => void
    const completedPathPromise = new Promise<string>((resolve, reject) => {
        pathResolve = resolve
    })
    mic.on('close', (code) => {
        console.log(`mic exited with code ${code}`);
        pathResolve(outPath)
    });

    return { completedPathPromise, fStop }
}

/**
 * Plays the given audio file, and resolves the `Promise` when that is finished, or rejects on error.
 */
export function playAudioFile(path: string): Promise<void> {
    // Stop any other music that might currently be playing
    stopPlayingMusic()

    // Play the file in question
    return new Promise((resolve, reject) => {
        const player = spawn('play', [path]);
        player.on('close', resolve)
        player.on('error', reject)
    })
}