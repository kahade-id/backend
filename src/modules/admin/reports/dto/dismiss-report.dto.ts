import { IsOptional, IsString, MaxLength, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

// BAI-127: catatan alasan dismiss — sebelumnya controller tidak menerima
// @Body() sama sekali sehingga catatan yang dikirim UI admin dibuang
// diam-diam. Catatan opsional; bila diisi disimpan di kolom `resolution`
// (kolom teks yang memang dipakai untuk catatan penanganan laporan) dan
// dicatat di audit log.
export class DismissReportDto {
  @ApiPropertyOptional({
    description: 'Catatan alasan pengabaian laporan (opsional)',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(2000)
  notes?: string;
}
