import Foundation
import AVFoundation
import CoreVideo

func fail(_ message: String) -> NSError { NSError(domain:"AutorioTimelapse",code:1,userInfo:[NSLocalizedDescriptionKey:message]) }
func describe(_ url: URL) async throws -> [String: Any] {
    let asset=AVURLAsset(url:url)
    let tracks=try await asset.loadTracks(withMediaType:.video)
    guard let track=tracks.first else { throw fail("Recording has no video track") }
    let fps=try await track.load(.nominalFrameRate)
    let duration=try await asset.load(.duration)
    return ["fps":fps,"duration_seconds":CMTimeGetSeconds(duration)]
}
func convert(_ source: URL, _ destination: URL) async throws -> [String: Any] {
    let asset=AVURLAsset(url:source)
    let tracks=try await asset.loadTracks(withMediaType:.video)
    guard let track=tracks.first else { throw fail("Recording has no video track") }
    let size=try await track.load(.naturalSize)
    let transform=try await track.load(.preferredTransform)
    let fps=try await track.load(.nominalFrameRate)
    guard abs(fps-5)<0.1 else { throw fail("Expected a 5 fps recording, got \(fps)") }
    let reader=try AVAssetReader(asset:asset)
    let output=AVAssetReaderTrackOutput(track:track,outputSettings:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
    output.alwaysCopiesSampleData=false
    guard reader.canAdd(output) else { throw fail("Cannot decode recording") }
    reader.add(output)
    let writer=try AVAssetWriter(outputURL:destination,fileType:.mp4)
    let input=AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:AVVideoCodecType.h264,AVVideoWidthKey:Int(size.width),AVVideoHeightKey:Int(size.height),AVVideoCompressionPropertiesKey:[AVVideoAverageBitRateKey:8_000_000,AVVideoExpectedSourceFrameRateKey:30]])
    input.transform=transform;input.expectsMediaDataInRealTime=false
    guard writer.canAdd(input) else { throw fail("Cannot encode timelapse") }
    writer.add(input)
    guard writer.startWriting() else { throw writer.error ?? fail("Could not start video writer") }
    writer.startSession(atSourceTime:.zero)
    guard reader.startReading() else { throw reader.error ?? fail("Could not start video reader") }
    var frames:Int64=0
    while let sample=output.copyNextSampleBuffer() {
        while !input.isReadyForMoreMediaData {
            if writer.status == .failed { throw writer.error ?? fail("Video writer failed") }
            try await Task.sleep(nanoseconds:2_000_000)
        }
        var timing=CMSampleTimingInfo(duration:CMTime(value:1,timescale:30),presentationTimeStamp:CMTime(value:frames,timescale:30),decodeTimeStamp:.invalid)
        var retimed:CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(allocator:kCFAllocatorDefault,sampleBuffer:sample,sampleTimingEntryCount:1,sampleTimingArray:&timing,sampleBufferOut:&retimed)==noErr,
              let retimed=retimed,input.append(retimed) else { throw writer.error ?? fail("Could not append video frame") }
        frames+=1
    }
    guard reader.status == .completed,frames>0 else { throw reader.error ?? fail("Recording is empty or decoding failed") }
    writer.endSession(atSourceTime:CMTime(value:frames,timescale:30))
    input.markAsFinished()
    await writer.finishWriting()
    guard writer.status == .completed else { throw writer.error ?? fail("Could not finish timelapse") }
    var result=try await describe(destination)
    result["frames"]=frames;result["capture_fps"]=5;result["playback_fps"]=30;result["speed"]=6;result["audio"]=false
    return result
}
func testSource(_ url:URL) async throws {
    let writer=try AVAssetWriter(outputURL:url,fileType:.mov)
    let input=AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:AVVideoCodecType.h264,AVVideoWidthKey:320,AVVideoHeightKey:180,AVVideoCompressionPropertiesKey:[AVVideoExpectedSourceFrameRateKey:5]])
    let adaptor=AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:input,sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32ARGB,kCVPixelBufferWidthKey as String:320,kCVPixelBufferHeightKey as String:180])
    writer.add(input);guard writer.startWriting() else { throw writer.error ?? fail("Test writer failed") };writer.startSession(atSourceTime:.zero)
    for frame in 0..<30 {
        while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds:2_000_000) }
        var pixel:CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault,adaptor.pixelBufferPool!,&pixel)==kCVReturnSuccess,let pixel=pixel else { throw fail("Test frame allocation failed") }
        CVPixelBufferLockBaseAddress(pixel,[])
        memset(CVPixelBufferGetBaseAddress(pixel),Int32(frame*8),CVPixelBufferGetDataSize(pixel))
        CVPixelBufferUnlockBaseAddress(pixel,[])
        guard adaptor.append(pixel,withPresentationTime:CMTime(value:Int64(frame),timescale:5)) else { throw writer.error ?? fail("Test frame failed") }
    }
    writer.endSession(atSourceTime:CMTime(value:6,timescale:1));input.markAsFinished();await writer.finishWriting()
    guard writer.status == .completed else { throw writer.error ?? fail("Test source failed") }
}
@main struct Timelapse {
    static func main() async {
        do {
            let args=Array(CommandLine.arguments.dropFirst())
            let result:[String:Any]
            if args.count==2 && args[0]=="--inspect" { result=try await describe(URL(fileURLWithPath:args[1])) }
            else if args.count==2 && args[0]=="--test-source" { try await testSource(URL(fileURLWithPath:args[1]));result=try await describe(URL(fileURLWithPath:args[1])) }
            else if args.count==2 { result=try await convert(URL(fileURLWithPath:args[0]),URL(fileURLWithPath:args[1])) }
            else { throw fail("Usage: timelapse INPUT OUTPUT.mp4") }
            let data=try JSONSerialization.data(withJSONObject:result,options:.sortedKeys)
            FileHandle.standardOutput.write(data);print("")
        } catch { FileHandle.standardError.write(Data((error.localizedDescription+"\n").utf8));exit(1) }
    }
}
