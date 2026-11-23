// swift encode.swift <frames dir of 00000.jpg…> <audio.wav> <out.mp4>
// Writes the frames at 60 fps and the soundtrack (AAC) into an H.264 MP4.
import AVFoundation
import ImageIO

let args = CommandLine.arguments
let framesDir = URL(fileURLWithPath: args[1]), wavURL = URL(fileURLWithPath: args[2]), outURL = URL(fileURLWithPath: args[3])
let fps: Int32 = 60, W = 1920, H = 1080

let frames = try FileManager.default.contentsOfDirectory(atPath: framesDir.path).filter { $0.hasSuffix(".jpg") }.sorted()
try? FileManager.default.removeItem(at: outURL)
let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
writer.shouldOptimizeForNetworkUse = true

let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: W, AVVideoHeightKey: H,
    AVVideoColorPropertiesKey: [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
    ],
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 20_000_000,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoMaxKeyFrameIntervalKey: 60,
        AVVideoExpectedSourceFrameRateKey: fps,
    ],
])
vIn.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vIn, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H,
])
let aIn = AVAssetWriterInput(mediaType: .audio, outputSettings: [
    AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 256_000,
])
aIn.expectsMediaDataInRealTime = false
writer.add(vIn)
writer.add(aIn)

let asset = AVURLAsset(url: wavURL)
let reader = try AVAssetReader(asset: asset)
let rOut = AVAssetReaderTrackOutput(track: asset.tracks(withMediaType: .audio)[0], outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
])
reader.add(rOut)
reader.startReading()

writer.startWriting()
writer.startSession(atSourceTime: .zero)
let rgb = CGColorSpace(name: CGColorSpace.sRGB)!
let group = DispatchGroup()

group.enter()
var next = 0
vIn.requestMediaDataWhenReady(on: DispatchQueue(label: "video")) {
    while vIn.isReadyForMoreMediaData {
        if next == frames.count { vIn.markAsFinished(); group.leave(); return }
        let src = CGImageSourceCreateWithURL(framesDir.appendingPathComponent(frames[next]) as CFURL, nil)!
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil)!
        var pb: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
        CVPixelBufferLockBaseAddress(pb!, [])
        let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb!), width: W, height: H, bitsPerComponent: 8,
                            bytesPerRow: CVPixelBufferGetBytesPerRow(pb!), space: rgb,
                            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
        CVPixelBufferUnlockBaseAddress(pb!, [])
        adaptor.append(pb!, withPresentationTime: CMTime(value: CMTimeValue(next), timescale: fps))
        next += 1
    }
}

group.enter()
aIn.requestMediaDataWhenReady(on: DispatchQueue(label: "audio")) {
    while aIn.isReadyForMoreMediaData {
        guard let sb = rOut.copyNextSampleBuffer() else { aIn.markAsFinished(); group.leave(); return }
        aIn.append(sb)
    }
}

group.wait()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
guard writer.status == .completed else { fatalError("\(writer.error!)") }
print("\(outURL.lastPathComponent): \(frames.count) frames, \(Double(frames.count) / Double(fps)) s")
