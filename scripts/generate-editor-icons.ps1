# Small, local PNG assets keep the native mini-program toolbar independent of fonts and network requests.
Add-Type -AssemblyName System.Drawing
$editorAssetDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\miniprogram\assets\editor'))
[System.IO.Directory]::CreateDirectory($editorAssetDirectory) | Out-Null
$editorIconNames = @('font','h1','h2','h3','bullet','ordered','bold','strike','underline','italic','color','highlight','more','chevron','image','checklist','indent','align-left','align-center','align-right','align-justify','undo','redo','clear','check','check-light')
foreach ($editorIconName in $editorIconNames) {
  foreach ($editorVariant in @('', '-active')) {
    $editorBitmap = [System.Drawing.Bitmap]::new(96, 96)
    $editorGraphics = [System.Drawing.Graphics]::FromImage($editorBitmap)
    $editorGraphics.Clear([System.Drawing.Color]::Transparent)
    $editorGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $editorGraphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $editorGraphics.ScaleTransform(4, 4)
    $editorColor = if ($editorIconName -eq 'check-light') { '#ffffff' } elseif ($editorVariant) { '#3370ff' } else { '#1f2329' }
    $editorPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml($editorColor), 1.65)
    $editorPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $editorPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $editorPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $editorBrush = [System.Drawing.SolidBrush]::new($editorPen.Color)
    $editorFont = $null
    $editorPath = $null
    try {
      switch -Regex ($editorIconName) {
        '^(font|h1|h2|h3|bold|strike|underline|italic|color)$' {
          $editorGlyph = switch ($editorIconName) { 'font' {'Aa'} 'h1' {'H1'} 'h2' {'H2'} 'h3' {'H3'} 'bold' {'B'} 'strike' {'S'} 'underline' {'U'} 'italic' {'I'} 'color' {'A'} }
          $editorStyle = if ($editorIconName -eq 'bold') { [System.Drawing.FontStyle]::Bold } elseif ($editorIconName -eq 'italic') { [System.Drawing.FontStyle]::Italic } else { [System.Drawing.FontStyle]::Regular }
          $editorSize = if ($editorIconName -eq 'font') { 16 } elseif ($editorIconName -match '^h') { 17 } else { 21 }
          $editorFont = [System.Drawing.Font]::new('Segoe UI', $editorSize, $editorStyle, [System.Drawing.GraphicsUnit]::Pixel)
          $editorFormat = [System.Drawing.StringFormat]::new()
          try {
            $editorFormat.Alignment = [System.Drawing.StringAlignment]::Center
            $editorFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
            $editorFormat.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
            $editorGraphics.DrawString($editorGlyph, $editorFont, $editorBrush, [System.Drawing.RectangleF]::new(-8,-1,40,25), $editorFormat)
          } finally { $editorFormat.Dispose() }
          if ($editorIconName -eq 'strike') { $editorGraphics.DrawLine($editorPen, 5,12,19,12) }
          if ($editorIconName -eq 'underline') { $editorGraphics.DrawLine($editorPen, 5,22,19,22) }
        }
        '^(bullet|ordered)$' {
          foreach ($editorY in @(5,12,19)) { $editorGraphics.DrawLine($editorPen,9,$editorY,21,$editorY) }
          if ($editorIconName -eq 'bullet') { foreach ($editorY in @(4,11,18)) { $editorGraphics.FillEllipse($editorBrush,2,$editorY,2.5,2.5) } }
          else {
            $editorFont = [System.Drawing.Font]::new('Segoe UI',8,[System.Drawing.FontStyle]::Regular,[System.Drawing.GraphicsUnit]::Pixel)
            $editorGraphics.DrawString('1',$editorFont,$editorBrush,0,-1); $editorGraphics.DrawString('2',$editorFont,$editorBrush,0,6); $editorGraphics.DrawString('3',$editorFont,$editorBrush,0,13)
          }
        }
        '^checklist$' { $editorGraphics.DrawRectangle($editorPen,4,4,16,16); $editorGraphics.DrawLine($editorPen,7,12,10,15); $editorGraphics.DrawLine($editorPen,10,15,17,8) }
        '^highlight$' {
          $editorGraphics.DrawLines($editorPen,[System.Drawing.PointF[]]@([System.Drawing.PointF]::new(5,10),[System.Drawing.PointF]::new(12,3),[System.Drawing.PointF]::new(19,10),[System.Drawing.PointF]::new(12,17),[System.Drawing.PointF]::new(5,10)))
          $editorGraphics.DrawLine($editorPen,8,2,15,9); $editorGraphics.DrawLine($editorPen,6,10,17,10)
          $editorGraphics.FillEllipse($editorBrush,19,15,3,4)
        }
        '^more$' { foreach ($editorX in @(4,11,18)) { $editorGraphics.FillEllipse($editorBrush,$editorX,11,2.5,2.5) } }
        '^chevron$' { $editorGraphics.DrawLine($editorPen,5,9,12,16); $editorGraphics.DrawLine($editorPen,12,16,19,9) }
        '^image$' {
          $editorGraphics.DrawRectangle($editorPen,3,3,18,18); $editorGraphics.DrawEllipse($editorPen,7,7,3,3)
          $editorGraphics.DrawLines($editorPen,[System.Drawing.PointF[]]@([System.Drawing.PointF]::new(4,18),[System.Drawing.PointF]::new(10,12),[System.Drawing.PointF]::new(14,16),[System.Drawing.PointF]::new(20,9)))
        }
        '^indent$' { $editorGraphics.DrawLine($editorPen,19,3,19,21); $editorGraphics.DrawLine($editorPen,2,12,15,12); $editorGraphics.DrawLine($editorPen,11,8,15,12); $editorGraphics.DrawLine($editorPen,11,16,15,12) }
        '^align-' {
          foreach ($editorY in @(4,9,14,19)) {
            $editorShort = $editorY -in @(9,19)
            $editorLeft = if ($editorIconName -eq 'align-right' -and $editorShort) { 10 } elseif ($editorIconName -eq 'align-center' -and $editorShort) { 7 } else { 3 }
            $editorRight = if ($editorIconName -eq 'align-left' -and $editorShort) { 14 } elseif ($editorIconName -eq 'align-center' -and $editorShort) { 17 } else { 21 }
            $editorGraphics.DrawLine($editorPen,$editorLeft,$editorY,$editorRight,$editorY)
          }
        }
        '^(undo|redo)$' {
          if ($editorIconName -eq 'redo') { $editorGraphics.TranslateTransform(24,0); $editorGraphics.ScaleTransform(-1,1) }
          $editorGraphics.DrawArc($editorPen,5,6,16,13,210,235); $editorGraphics.DrawLine($editorPen,4,4,4,11); $editorGraphics.DrawLine($editorPen,4,11,11,11)
        }
        '^clear$' {
          $editorGraphics.DrawLines($editorPen,[System.Drawing.PointF[]]@([System.Drawing.PointF]::new(3,15),[System.Drawing.PointF]::new(13,4),[System.Drawing.PointF]::new(21,11),[System.Drawing.PointF]::new(12,21),[System.Drawing.PointF]::new(8,21),[System.Drawing.PointF]::new(3,15)))
          $editorGraphics.DrawLine($editorPen,7,11,16,18); $editorGraphics.DrawLine($editorPen,12,21,22,21)
        }
        '^check' { $editorGraphics.DrawLine($editorPen,4,12,9,17); $editorGraphics.DrawLine($editorPen,9,17,20,6) }
      }
      $editorBitmap.Save((Join-Path $editorAssetDirectory ($editorIconName + $editorVariant + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      if ($editorFont) { $editorFont.Dispose() }
      if ($editorPath) { $editorPath.Dispose() }
      $editorBrush.Dispose(); $editorPen.Dispose(); $editorGraphics.Dispose(); $editorBitmap.Dispose()
    }
  }
}
Write-Output 'Generated 52 editor icons.'
