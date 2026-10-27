param(
    [ValidateSet('lab-equipment', 'finance', 'weekly', 'activities', 'ai-challenge', 'approvals', 'leave', 'knowledge', 'weekly-sharing')]
    [string[]]$Only = @('lab-equipment', 'finance', 'weekly', 'activities', 'ai-challenge', 'approvals', 'leave', 'knowledge', 'weekly-sharing')
)
Add-Type -AssemblyName System.Drawing
$assetDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\miniprogram\assets\workbench'))
foreach ($iconName in $Only) {
    $bitmap = New-Object System.Drawing.Bitmap 192, 192
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#101b2b')), 7
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    switch ($iconName) {
        'leave' {
            $graphics.DrawLines($pen, [System.Drawing.Point[]]@((New-Object System.Drawing.Point 78,160), (New-Object System.Drawing.Point 30,160), (New-Object System.Drawing.Point 30,41), (New-Object System.Drawing.Point 156,41), (New-Object System.Drawing.Point 156,80)))
            $graphics.DrawLine($pen, 30,72,156,72)
            $graphics.DrawLine($pen, 61,26,61,53)
            $graphics.DrawLine($pen, 125,26,125,53)
            $graphics.DrawLine($pen, 50,98,76,98)
            $graphics.DrawLine($pen, 50,122,66,122)
            $graphics.DrawEllipse($pen, 91,93,76,76)
            $graphics.DrawLine($pen, 129,109,129,132)
            $graphics.DrawLine($pen, 129,132,145,141)
        }
        'knowledge' {
            $left = [System.Drawing.Point[]]@((New-Object System.Drawing.Point 96,47), (New-Object System.Drawing.Point 76,35), (New-Object System.Drawing.Point 28,35), (New-Object System.Drawing.Point 28,148), (New-Object System.Drawing.Point 76,148), (New-Object System.Drawing.Point 96,160))
            $right = [System.Drawing.Point[]]@((New-Object System.Drawing.Point 96,47), (New-Object System.Drawing.Point 116,35), (New-Object System.Drawing.Point 164,35), (New-Object System.Drawing.Point 164,148), (New-Object System.Drawing.Point 116,148), (New-Object System.Drawing.Point 96,160))
            $graphics.DrawLines($pen, $left)
            $graphics.DrawLines($pen, $right)
            $graphics.DrawLine($pen, 96,47,96,160)
            $graphics.DrawLine($pen, 46,66,74,66)
            $graphics.DrawLine($pen, 46,91,74,91)
            $graphics.DrawLine($pen, 46,116,74,116)
            $graphics.DrawLine($pen, 118,66,146,66)
            $graphics.DrawLine($pen, 118,91,146,91)
            $graphics.DrawLine($pen, 118,116,146,116)
        }
        'weekly-sharing' {
            $graphics.DrawRectangle($pen, 27,33,138,99)
            $graphics.DrawLine($pen, 96,132,96,164)
            $graphics.DrawLine($pen, 68,164,124,164)
            $graphics.DrawEllipse($pen, 48,54,24,24)
            $graphics.DrawArc($pen, 40,87,40,36,180,180)
            $graphics.DrawLine($pen, 99,59,144,59)
            $graphics.DrawLine($pen, 99,82,144,82)
            $graphics.DrawLine($pen, 99,105,130,105)
        }
        'lab-equipment' {
            $graphics.DrawRectangle($pen, 25,36,142,103)
            $graphics.DrawLine($pen, 96,139,96,166)
            $graphics.DrawLine($pen, 67,166,125,166)
            $points = [System.Drawing.Point[]]@((New-Object System.Drawing.Point 43,92), (New-Object System.Drawing.Point 66,92), (New-Object System.Drawing.Point 79,66), (New-Object System.Drawing.Point 98,111), (New-Object System.Drawing.Point 113,84), (New-Object System.Drawing.Point 147,84))
            $graphics.DrawLines($pen, $points)
        }
        'approvals' {
            $points = [System.Drawing.Point[]]@((New-Object System.Drawing.Point 64,42), (New-Object System.Drawing.Point 42,42), (New-Object System.Drawing.Point 42,162), (New-Object System.Drawing.Point 150,162), (New-Object System.Drawing.Point 150,42), (New-Object System.Drawing.Point 128,42))
            $graphics.DrawLines($pen, $points)
            $graphics.DrawRectangle($pen, 66,24,60,32)
            $graphics.DrawLine($pen, 64,103,85,124)
            $graphics.DrawLine($pen, 85,124,129,80)
        }
        'finance' {
            $points = [System.Drawing.Point[]]@((New-Object System.Drawing.Point 46,24), (New-Object System.Drawing.Point 124,24), (New-Object System.Drawing.Point 150,50), (New-Object System.Drawing.Point 150,164), (New-Object System.Drawing.Point 46,164), (New-Object System.Drawing.Point 46,24))
            $graphics.DrawLines($pen, $points)
            $graphics.DrawLine($pen, 122,25,122,54)
            $graphics.DrawLine($pen, 122,54,148,54)
            $graphics.DrawLine($pen, 78,69,97,90)
            $graphics.DrawLine($pen, 116,69,97,90)
            $graphics.DrawLine($pen, 97,90,97,126)
            $graphics.DrawLine($pen, 74,95,120,95)
            $graphics.DrawLine($pen, 74,109,120,109)
            $graphics.DrawLine($pen, 70,143,126,143)
        }
        'weekly' {
            $graphics.DrawRectangle($pen, 29,41,134,121)
            $graphics.DrawLine($pen, 29,75,163,75)
            $graphics.DrawLine($pen, 61,26,61,54)
            $graphics.DrawLine($pen, 131,26,131,54)
            $graphics.DrawLine($pen, 52,100,59,107)
            $graphics.DrawLine($pen, 59,107,73,91)
            $graphics.DrawLine($pen, 87,100,139,100)
            $graphics.DrawLine($pen, 52,130,59,137)
            $graphics.DrawLine($pen, 59,137,73,121)
            $graphics.DrawLine($pen, 87,130,139,130)
        }
        'activities' {
            $graphics.DrawLine($pen, 75,43,151,26)
            $graphics.DrawLine($pen, 75,65,151,48)
            $graphics.DrawLine($pen, 75,43,75,137)
            $graphics.DrawLine($pen, 151,26,151,120)
            $graphics.DrawEllipse($pen, 33,123,42,32)
            $graphics.DrawEllipse($pen, 109,106,42,32)
            $graphics.DrawLine($pen, 34,54,34,78)
            $graphics.DrawLine($pen, 22,66,46,66)
        }
        'ai-challenge' {
            $graphics.DrawLine($pen, 56,35,136,35)
            $graphics.DrawLine($pen, 56,35,56,83)
            $graphics.DrawLine($pen, 136,35,136,83)
            $graphics.DrawArc($pen, 56,48,80,76,0,180)
            $graphics.DrawArc($pen, 25,46,63,63,90,180)
            $graphics.DrawArc($pen, 104,46,63,63,270,180)
            $graphics.DrawLine($pen, 96,124,96,150)
            $graphics.DrawLine($pen, 65,164,127,164)
            $graphics.DrawLine($pen, 79,150,113,150)
            $graphics.DrawLine($pen, 79,150,65,164)
            $graphics.DrawLine($pen, 113,150,127,164)
            $graphics.DrawLine($pen, 97,55,84,80)
            $graphics.DrawLine($pen, 84,80,107,80)
            $graphics.DrawLine($pen, 107,80,94,101)
        }
    }
    $bitmap.Save((Join-Path $assetDirectory ($iconName + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
    $pen.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}
Write-Output ('Generated ' + $Only.Count + ' workbench icons.')
