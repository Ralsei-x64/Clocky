$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Length -eq 1 -and $_.GetParameters().Length -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($operation, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    $task.GetAwaiter().GetResult()
}
$manager = Await ($managerType::RequestAsync()) $managerType
$session = $manager.GetCurrentSession()
if (!$session) { 'null'; exit }
$info = Await ($session.TryGetMediaPropertiesAsync()) $propsType
$timeline = $session.GetTimelineProperties()
$playing = $session.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing'
$position = $timeline.Position.TotalSeconds
if ($playing) { $position += [Math]::Max(0, ([DateTimeOffset]::UtcNow - $timeline.LastUpdatedTime).TotalSeconds) }
$art = $null
if ($info.Thumbnail) {
    try {
        $streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]
        $stream = Await ($info.Thumbnail.OpenReadAsync()) $streamType
        if ($stream.Size -le 4194304) {
            $read = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
            Add-Type -AssemblyName System.Drawing
            $bitmap = [Drawing.Bitmap]::FromStream($read)
            $thumb = $bitmap.GetThumbnailImage(72,72,$null,[IntPtr]::Zero)
            $out = [IO.MemoryStream]::new()
            $thumb.Save($out,[Drawing.Imaging.ImageFormat]::Png)
            $art = 'data:image/png;base64,' + [Convert]::ToBase64String($out.ToArray())
        }
    } catch {}
}
@{title=$info.Title; artist=$info.Artist; duration=$timeline.EndTime.TotalSeconds; position=$position; playing=$playing; art=$art} | ConvertTo-Json -Compress
