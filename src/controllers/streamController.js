import prisma from '../config/prismaClient.js';
import { uploadToS3 } from '../services/s3Service.js';
import { captureFrames } from '../services/captureFrames.js';
import path from 'path';
import fs from 'fs';

export const uploadRecording = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded', error: 'File is required' });
    }

    const { reportId, userId } = req.body;

    if (!reportId || !userId) {
      return res.status(400).json({ message: 'reportId와 userId가 필요합니다.' });
    }

    // 토큰에서 추출한 사용자 ID와 요청에서 전달된 userId 비교
    if (req.user.userId !== parseInt(userId, 10)) {
      return res.status(403).json({ message: '권한이 없습니다. 요청한 userId가 토큰과 일치하지 않습니다.' });
    }

    // DB에서 reportId 존재 여부 확인
    const reportExists = await prisma.report.findUnique({
      where: { report_id: reportId },
    });

    if (!reportExists) {
      return res.status(404).json({ message: '해당 reportId가 존재하지 않습니다.' });
    }

    const folderName = 'recordings/';
    const videoPath = req.file.path;
    const outputDir = path.join('public', 'recordings', 'frames');
    const videoDir = path.join('public', 'video'); // 로컬 video 디렉토리
    const frameCount = 6;

    // 캡처 이미지 생성
    const capturedImages = await captureFrames(videoPath, outputDir, frameCount);

    // 캡처 이미지들을 S3에 업로드
    const imageFolder = `${folderName}frames/`;
    const uploadedImages = await Promise.allSettled(
      capturedImages.map(async (imagePath) => {
        if (!fs.existsSync(imagePath)) {
          console.error(`File not found: ${imagePath}`);
          return null;
        }
        try {
          const fileName = path.basename(imagePath);
          const imageResult = await uploadToS3(
            { path: imagePath, mimetype: 'image/jpeg' },
            `${imageFolder}${Date.now()}-${fileName}`
          );
          fs.unlinkSync(imagePath); // 파일 삭제
          return imageResult.Location;
        } catch (error) {
          console.error(`Failed to upload image: ${imagePath}`, error);
          return null;
        }
      })
    );

    // 성공한 업로드만 필터링
    const successfulUploads = uploadedImages
      .filter((result) => result.status === 'fulfilled' && result.value)
      .map((result) => result.value);

    if (successfulUploads.length < frameCount) {
      console.warn(
        `Expected ${frameCount} images but only ${successfulUploads.length} were uploaded successfully.`
      );
    }

    console.log('Successfully uploaded images:', successfulUploads);

    //  DB 업데이트: Reports 테이블
    const updatedReport = await prisma.report.update({
      where: { report_id: reportId },
      data: {
        fileUrl: successfulUploads, // 캡처된 이미지 URL 배열 저장
        fileType: 'image',         // 항상 "image"
      },
    });

    // 로컬 임시 파일 정리
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
    console.log('Temporary frames cleaned up.');

    // video 폴더 정리
    if (fs.existsSync(videoDir)) {
      fs.readdirSync(videoDir).forEach((file) => {
        const filePath = path.join(videoDir, file);
        try {
          fs.unlinkSync(filePath);
          console.log(`Deleted video file: ${filePath}`);
        } catch (error) {
          console.error(`Failed to delete video file: ${filePath}`, error);
        }
      });
    }
    res.status(200).json({
      message: 'File processed and uploaded successfully',
      updatedReport,
    });
  } catch (error) {
    console.error('Upload process error:', error);
    res.status(500).json({ message: 'Upload error', error: error.message });
  }
};
